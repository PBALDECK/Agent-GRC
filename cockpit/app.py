"""Cockpit GRC — veille législative (Streamlit).

Lancer depuis la racine du projet :   streamlit run cockpit/app.py

4 vues : Fil de veille · Textes et matrices · Validation humaine · Pilotage et échéances.
Les décisions humaines (valider / corriger / rejeter) sont écrites dans Notion
et tracées dans data/journal_validation.jsonl.
"""

from __future__ import annotations

import json
import os
import time
import unicodedata
from datetime import date, datetime
from pathlib import Path
import pandas as pd
import requests
import streamlit as st
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

TOKEN = os.getenv("NOTION_API_KEY", "")
API = "https://api.notion.com/v1"

# Mêmes identifiants que src/agent.ts (surchargeables via .env : NOTION_DB_EXIGENCES=...).
DB = {
    "textes": os.getenv("NOTION_DB_TEXTES", "4066959030358077997bc05b06462974"),
    "exigences": os.getenv("NOTION_DB_EXIGENCES", "40669590303580adb9c2dce8aa09e4f0"),
    "controles": os.getenv("NOTION_DB_CONTROLES", "4066959030358043a916daeaf015b574"),
    "risques": os.getenv("NOTION_DB_RISQUES", "40669590303580b186cefcca7e7b8d14"),
    "jurisprudence": os.getenv("NOTION_DB_JURISPRUDENCE", "40669590303580cb99c8c38d0cfb0fe8"),
    "actions": os.getenv("NOTION_DB_ACTIONS", "40669590303580698113e40cb801a2b4"),
}

FICHIER_EXIGENCES = ROOT / "data" / "exigences.json"
FICHIER_GOUVERNANCE = ROOT / "data" / "gouvernance.json"
FICHIER_DECISION = ROOT / "data" / "decision_gouvernance.json"
FICHIER_MATRICES = ROOT / "data" / "matrices" / "Matrices_GRC.xlsx"
FICHIER_JOURNAL = ROOT / "data" / "journal_validation.jsonl"


# ==================================================
# Utilitaires
# ==================================================

def norm(texte: str) -> str:
    """Même normalisation que l'agent : sans accents, minuscules, lettres/chiffres seulement."""
    t = unicodedata.normalize("NFD", str(texte or ""))
    t = "".join(c for c in t if unicodedata.category(c) != "Mn").lower()
    return "".join(c for c in t if c.isalnum())


def colonne(df: pd.DataFrame, *candidats: str) -> str | None:
    """Nom réel d'une colonne Notion (tolère accents, casse et espaces finaux)."""
    for cand in candidats:
        for nom in df.columns:
            if norm(nom) == norm(cand):
                return nom
    return None


def pourcent(valeur) -> str:
    try:
        return f"{float(valeur):.0%}"
    except (TypeError, ValueError):
        return "—"


# ==================================================
# Accès Notion (API 2025-09-03 : bases -> sources de données)
# ==================================================

def _requete(methode: str, chemin: str, **kwargs):
    entetes = {
        "Authorization": f"Bearer {TOKEN}",
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json",
    }
    for _ in range(4):
        r = requests.request(methode, API + chemin, headers=entetes, timeout=30, **kwargs)
        if r.status_code == 429:
            time.sleep(float(r.headers.get("Retry-After", "1")))
            continue
        if not r.ok:
            raise RuntimeError(f"Notion {r.status_code} sur {chemin} : {r.text[:300]}")
        return r.json()
    raise RuntimeError(f"Notion : trop de requêtes sur {chemin}")


@st.cache_data(ttl=3600, show_spinner=False)
def source_de_donnees(db_id: str) -> str:
    db = _requete("GET", f"/databases/{db_id}")
    sources = db.get("data_sources") or []
    if not sources:
        raise RuntimeError(f"Aucune source de données pour la base {db_id} (accès de l'intégration ?)")
    return sources[0]["id"]


@st.cache_data(ttl=3600, show_spinner=False)
def schema(db_id: str) -> dict:
    return _requete("GET", f"/data_sources/{source_de_donnees(db_id)}")["properties"]


def options_select(db_id: str, propriete: str | None) -> list[str]:
    if not propriete:
        return []
    prop = schema(db_id).get(propriete, {})
    return [o["name"] for o in prop.get("select", {}).get("options", [])]


def colonne_titre(db_id: str) -> str:
    """Nom de la propriété de type titre d'une base."""
    return next(nom for nom, prop in schema(db_id).items() if prop["type"] == "title")


def _lire(prop: dict):
    t = prop.get("type")
    v = prop.get(t)
    if t in ("title", "rich_text"):
        return "".join(x.get("plain_text", "") for x in v or [])
    if t in ("select", "status"):
        return v["name"] if v else ""
    if t == "multi_select":
        return ", ".join(x["name"] for x in v or [])
    if t == "date":
        return v["start"] if v else None
    if t == "relation":
        return [x["id"] for x in v or []]
    if t == "people":
        return ", ".join(p.get("name", "?") for p in v or [])
    if t in ("number", "checkbox", "url"):
        return v
    return None


@st.cache_data(ttl=30, show_spinner="Lecture de Notion…")
def charger(db_id: str) -> pd.DataFrame:
    lignes, curseur = [], None
    while True:
        corps = {"page_size": 100}
        if curseur:
            corps["start_cursor"] = curseur
        rep = _requete("POST", f"/data_sources/{source_de_donnees(db_id)}/query", json=corps)
        for page in rep["results"]:
            ligne = {"_page_id": page["id"], "_url": page["url"], "_modifie": page["last_edited_time"]}
            for nom, prop in page["properties"].items():
                ligne[nom] = _lire(prop)
            lignes.append(ligne)
        if not rep.get("has_more"):
            break
        curseur = rep["next_cursor"]
    return pd.DataFrame(lignes)


def maj_page(page_id: str, proprietes: dict) -> None:
    _requete("PATCH", f"/pages/{page_id}", json={"properties": proprietes})
    charger.clear()


def p_select(valeur: str) -> dict:
    return {"select": {"name": valeur.replace(",", " ")[:100]}}


def p_texte(valeur: str) -> dict:
    morceaux = [valeur[i:i + 2000] for i in range(0, len(valeur), 2000)] or [""]
    return {"rich_text": [{"type": "text", "text": {"content": m}} for m in morceaux]}


def p_date(valeur: date | None) -> dict:
    return {"date": {"start": valeur.isoformat()} if valeur else None}


# ==================================================
# Données locales (produites par l'agent)
# ==================================================

@st.cache_data(ttl=30, show_spinner=False)
def analyses_locales() -> dict:
    """ID exigence -> objet de data/exigences.json (avec 'analyse')."""
    try:
        data = json.loads(FICHIER_EXIGENCES.read_text(encoding="utf-8"))
        return {e["id"]: e for e in data.get("exigences", [])}
    except (OSError, ValueError):
        return {}


def lire_json(chemin: Path) -> dict | None:
    try:
        return json.loads(chemin.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def journaliser(entree: dict) -> None:
    FICHIER_JOURNAL.parent.mkdir(parents=True, exist_ok=True)
    entree = {"horodatage": datetime.now().isoformat(timespec="seconds"), **entree}
    with FICHIER_JOURNAL.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entree, ensure_ascii=False) + "\n")


# ==================================================
# Contexte commun : colonnes et statuts
# ==================================================

def contexte():
    ex = charger(DB["exigences"])
    if ex.empty:
        return ex, {}, {}

    c = {
        "id": colonne(ex, "ID Exigence"),
        "article": colonne(ex, "Article"),
        "description": colonne(ex, "Description"),
        "criticite": colonne(ex, "Criticité", "Criticite"),
        "statut": colonne(ex, "Statut"),
        "texte": colonne(ex, "Texte origine"),
        "citation": colonne(ex, "Citation"),
        "echeance": colonne(ex, "Échéance", "Echeance"),
        "sanction": colonne(ex, "Sanction"),
        "verifiee": colonne(ex, "Citation vérifiée", "Citation verifiee"),
        "confiance": colonne(ex, "Confiance"),
    }

    opts = options_select(DB["exigences"], c["statut"])

    def option(debut: str, defaut: str) -> str:
        return next((o for o in opts if norm(o).startswith(debut)), defaut)

    statuts = {
        "a_valider": option("avalid", "À valider"),
        "valide": option("valid", "Validée"),
        "rejete": option("rej", "Rejetée"),
    }
    statuts["corrige"] = option("corrig", statuts["valide"])
    return ex, c, statuts


def est_a_valider(valeur: str, statuts: dict) -> bool:
    return norm(valeur) == norm(statuts["a_valider"])


def liees(df: pd.DataFrame, relation: str | None, page_id: str) -> pd.DataFrame:
    if df.empty or not relation or relation not in df.columns:
        return df.iloc[0:0]
    return df[df[relation].apply(lambda ids: page_id in (ids or []))]


def afficher_detail(ligne: pd.Series, c: dict) -> None:
    """Fiche d'une exigence : texte, citation, qualité, analyse d'impact et éléments liés."""
    st.markdown(f"#### {ligne[c['id']]} — {ligne[c['article']]}")
    st.write(ligne[c["description"]])

    col1, col2, col3, col4 = st.columns(4)
    col1.metric("Criticité", ligne[c["criticite"]] or "—")
    col2.metric("Statut", ligne[c["statut"]] or "—")
    col3.metric("Confiance", pourcent(ligne[c["confiance"]]) if c["confiance"] else "—")
    if c["verifiee"]:
        col4.metric("Citation vérifiée", "oui" if ligne[c["verifiee"]] else "NON")

    if c["verifiee"] and not ligne[c["verifiee"]]:
        st.warning("La citation n'a pas été retrouvée dans le texte source : vérifie l'exigence avant de la valider.")

    if c["citation"] and ligne[c["citation"]]:
        st.markdown(f"> {ligne[c['citation']]}")

    details = []
    if c["echeance"] and ligne[c["echeance"]]:
        details.append(f"**Échéance** : {ligne[c['echeance']]}")
    if c["sanction"] and ligne[c["sanction"]]:
        details.append(f"**Sanction** : {ligne[c['sanction']]}")
    if details:
        st.markdown("  \n".join(details))

    local = analyses_locales().get(ligne[c["id"]])
    analyse = (local or {}).get("analyse")
    if analyse:
        with st.expander("Analyse d'impact (agent)", expanded=False):
            st.markdown(
                f"**Couverture actuelle** : {analyse.get('couverture', '—')}  \n"
                f"**Écart** : {analyse.get('ecart') or '—'}  \n"
                f"**Mesures résiduelles** : {analyse.get('mesuresResiduelles') or '—'}  \n"
                f"**Gravité × vraisemblance résiduelles** : "
                f"{analyse.get('graviteResiduelle')} × {analyse.get('vraisemblanceResiduelle')}"
            )
            for libelle, cle in (("Processus", "processus"), ("Systèmes", "systemes"),
                                 ("Données", "donnees"), ("Contrats", "contrats")):
                if analyse.get(cle):
                    st.markdown(f"**{libelle}** : {', '.join(analyse[cle])}")


def elements_lies(page_id: str) -> None:
    blocs = (
        ("Contrôles", "controles", "Exigences Couvertes"),
        ("Risques", "risques", "Exigence Liée"),
        ("Actions", "actions", "Exigences Traitées"),
        ("Jurisprudence", "jurisprudence", "Exigences Impactées"),
    )
    for titre, cle, relation in blocs:
        df = charger(DB[cle])
        rel = colonne(df, relation) if not df.empty else None
        sel = liees(df, rel, page_id)
        with st.expander(f"{titre} ({len(sel)})"):
            if sel.empty:
                st.caption("Aucun élément lié.")
            else:
                visibles = [k for k in sel.columns if not k.startswith("_") and k != rel]
                st.dataframe(sel[visibles], hide_index=True, use_container_width=True)


# ==================================================
# Vue 1 — Fil de veille
# ==================================================

def vue_fil_de_veille() -> None:
    st.header("Fil de veille")
    ex, c, statuts = contexte()
    textes = charger(DB["textes"])

    if ex.empty:
        st.info("Aucune exigence dans Notion : lance d'abord `npm run agent`.")
        return

    a_valider = int(ex[c["statut"]].apply(lambda s: est_a_valider(s, statuts)).sum())
    try:
        dernier = datetime.fromtimestamp(FICHIER_EXIGENCES.stat().st_mtime).strftime("%d/%m/%Y %H:%M")
    except OSError:
        dernier = "—"

    k1, k2, k3, k4 = st.columns(4)
    k1.metric("Textes suivis", len(textes))
    k2.metric("Exigences", len(ex))
    k3.metric("À valider", a_valider)
    k4.metric("Dernière exécution de l'agent", dernier)

    st.subheader("Textes")
    if textes.empty:
        st.caption("Aucun texte.")
    else:
        nom_titre = colonne_titre(DB["textes"])
        col_url = colonne(textes, "URL")
        col_source = colonne(textes, "Source")
        col_date = colonne(textes, "date", "Date")

        def compter(page_id: str, seulement_a_valider: bool) -> int:
            sel = liees(ex, c["texte"], page_id)
            if seulement_a_valider:
                sel = sel[sel[c["statut"]].apply(lambda s: est_a_valider(s, statuts))]
            return len(sel)

        vue = pd.DataFrame({
            "Texte": textes[nom_titre],
            "Source": textes[col_source] if col_source else "",
            "Date": textes[col_date] if col_date else None,
            "Lien officiel": textes[col_url] if col_url else None,
            "Exigences": textes["_page_id"].apply(lambda p: compter(p, False)),
            "À valider": textes["_page_id"].apply(lambda p: compter(p, True)),
        })
        st.dataframe(
            vue, hide_index=True, use_container_width=True,
            column_config={"Lien officiel": st.column_config.LinkColumn("Lien officiel")},
        )

    st.subheader("Activité récente")
    recents = ex.sort_values("_modifie", ascending=False).head(15)
    st.dataframe(
        pd.DataFrame({
            "Exigence": recents[c["id"]],
            "Article": recents[c["article"]],
            "Criticité": recents[c["criticite"]],
            "Statut": recents[c["statut"]],
            "Modifiée le": pd.to_datetime(recents["_modifie"]).dt.strftime("%d/%m/%Y %H:%M"),
        }),
        hide_index=True, use_container_width=True,
    )


# ==================================================
# Vue 2 — Textes et matrices
# ==================================================

def vue_textes_matrices() -> None:
    st.header("Textes et matrices")
    ex, c, _ = contexte()
    textes = charger(DB["textes"])

    if ex.empty or textes.empty:
        st.info("Aucune donnée : lance d'abord `npm run agent`.")
        return

    nom_titre = colonne_titre(DB["textes"])
    choix = st.selectbox("Texte", textes.index, format_func=lambda i: textes.loc[i, nom_titre])
    texte = textes.loc[choix]
    sel = liees(ex, c["texte"], texte["_page_id"])

    col_a, col_b = st.columns(2)
    criticites = sorted(x for x in sel[c["criticite"]].unique() if x)
    statuts_dispo = sorted(x for x in sel[c["statut"]].unique() if x)
    f_crit = col_a.multiselect("Criticité", criticites, default=criticites)
    f_stat = col_b.multiselect("Statut", statuts_dispo, default=statuts_dispo)
    sel = sel[sel[c["criticite"]].isin(f_crit) & sel[c["statut"]].isin(f_stat)]

    st.caption(f"{len(sel)} exigence(s)")
    tableau = pd.DataFrame({
        "Exigence": sel[c["id"]],
        "Article": sel[c["article"]],
        "Criticité": sel[c["criticite"]],
        "Statut": sel[c["statut"]],
        "Confiance": sel[c["confiance"]] if c["confiance"] else None,
        "Citation vérifiée": sel[c["verifiee"]] if c["verifiee"] else None,
        "Échéance": sel[c["echeance"]] if c["echeance"] else None,
    })
    st.dataframe(
        tableau, hide_index=True, use_container_width=True,
        column_config={"Confiance": st.column_config.ProgressColumn("Confiance", min_value=0.0, max_value=1.0, format="%.2f")},
    )

    if not sel.empty:
        st.subheader("Consulter une exigence")
        i = st.selectbox("Exigence", sel.index, format_func=lambda k: f"{sel.loc[k, c['id']]} — {sel.loc[k, c['article']]}")
        ligne = sel.loc[i]
        afficher_detail(ligne, c)
        elements_lies(ligne["_page_id"])

    st.subheader("Matrices GRC (M1 à M5) et gouvernance")
    if not FICHIER_MATRICES.exists():
        st.caption("Le fichier Excel n'existe pas encore : lance `npm run agent`.")
        return

    st.download_button(
        "Télécharger Matrices_GRC.xlsx",
        data=FICHIER_MATRICES.read_bytes(),
        file_name="Matrices_GRC.xlsx",
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    feuilles = pd.ExcelFile(FICHIER_MATRICES).sheet_names
    feuille = st.selectbox("Aperçu d'une feuille", [f for f in feuilles if f != "Lisez-moi"] or feuilles)
    st.dataframe(pd.read_excel(FICHIER_MATRICES, sheet_name=feuille), hide_index=True, use_container_width=True)


# ==================================================
# Vue 3 — Validation humaine
# ==================================================

def vue_validation(relecteur: str) -> None:
    st.header("Validation humaine")
    onglet_ex, onglet_gouv = st.tabs(["Exigences à valider", "Décision de gouvernance"])

    with onglet_ex:
        _onglet_exigences(relecteur)
    with onglet_gouv:
        _onglet_gouvernance(relecteur)


def _onglet_exigences(relecteur: str) -> None:
    ex, c, statuts = contexte()
    if ex.empty:
        st.info("Aucune exigence : lance d'abord `npm run agent`.")
        return

    if "message" in st.session_state:
        st.success(st.session_state.pop("message"))

    file_attente = ex[ex[c["statut"]].apply(lambda s: est_a_valider(s, statuts))].copy()
    total = len(ex)
    st.progress((total - len(file_attente)) / total if total else 0.0,
                text=f"{total - len(file_attente)} / {total} exigences traitées")

    if file_attente.empty:
        st.success("Plus aucune exigence à valider 🎉")
    else:
        # Les moins fiables d'abord : citation non vérifiée, puis confiance croissante.
        file_attente["_tri_verif"] = file_attente[c["verifiee"]].fillna(False).astype(bool) if c["verifiee"] else True
        file_attente["_tri_conf"] = file_attente[c["confiance"]].fillna(0) if c["confiance"] else 0
        file_attente = file_attente.sort_values(["_tri_verif", "_tri_conf"])

        i = st.selectbox(
            "Exigence à relire (les moins fiables en premier)",
            file_attente.index,
            format_func=lambda k: (
                f"{file_attente.loc[k, c['id']]} — {file_attente.loc[k, c['article']]} "
                f"· confiance {pourcent(file_attente.loc[k, c['confiance']]) if c['confiance'] else '—'}"
            ),
        )
        ligne = file_attente.loc[i]
        pid = ligne["_page_id"]
        afficher_detail(ligne, c)

        st.divider()
        st.subheader("Ta décision")
        if not relecteur:
            st.warning("Renseigne ton nom dans la barre latérale pour pouvoir décider.")

        criticites = options_select(DB["exigences"], c["criticite"])
        courante = ligne[c["criticite"]]

        with st.form(f"form_{pid}"):
            st.caption("« Valider » enregistre l'exigence telle quelle (les champs ci-dessous sont ignorés). "
                       "« Corriger et valider » enregistre tes modifications.")
            n_desc = st.text_area("Description", value=ligne[c["description"]], height=150)
            n_crit = st.selectbox("Criticité", criticites or [courante],
                                  index=(criticites.index(courante) if courante in criticites else 0))
            n_ech = st.text_input("Échéance", value=ligne[c["echeance"]] if c["echeance"] else "")
            n_sanc = st.text_input("Sanction", value=ligne[c["sanction"]] if c["sanction"] else "")
            commentaire = st.text_area("Commentaire (obligatoire pour un rejet)", height=70)

            b1, b2, b3 = st.columns(3)
            valider = b1.form_submit_button("✅ Valider", use_container_width=True)
            corriger = b2.form_submit_button("✏️ Corriger et valider", use_container_width=True)
            rejeter = b3.form_submit_button("❌ Rejeter", use_container_width=True)

        if valider or corriger or rejeter:
            if not relecteur:
                st.error("Nom du relecteur manquant.")
            elif rejeter and not commentaire.strip():
                st.error("Un rejet doit être motivé : ajoute un commentaire.")
            else:
                avant = {
                    "description": ligne[c["description"]], "criticite": courante,
                    "echeance": ligne[c["echeance"]] if c["echeance"] else "",
                    "sanction": ligne[c["sanction"]] if c["sanction"] else "",
                    "statut": ligne[c["statut"]],
                }
                props, apres = {}, dict(avant)

                if corriger:
                    if n_desc != avant["description"]:
                        props[c["description"]] = p_texte(n_desc)
                        apres["description"] = n_desc
                    if n_crit != courante:
                        props[c["criticite"]] = p_select(n_crit)
                        apres["criticite"] = n_crit
                    if c["echeance"] and n_ech != avant["echeance"]:
                        props[c["echeance"]] = p_texte(n_ech)
                        apres["echeance"] = n_ech
                    if c["sanction"] and n_sanc != avant["sanction"]:
                        props[c["sanction"]] = p_texte(n_sanc)
                        apres["sanction"] = n_sanc

                cle_statut = "rejete" if rejeter else ("corrige" if corriger and props else "valide")
                props[c["statut"]] = p_select(statuts[cle_statut])
                apres["statut"] = statuts[cle_statut]

                try:
                    maj_page(pid, props)
                except RuntimeError as erreur:
                    st.error(f"Écriture Notion impossible : {erreur}")
                else:
                    journaliser({
                        "exigence": ligne[c["id"]], "page_id": pid, "relecteur": relecteur,
                        "decision": cle_statut, "commentaire": commentaire.strip(),
                        "avant": avant, "apres": apres,
                    })
                    st.session_state["message"] = f"{ligne[c['id']]} → {statuts[cle_statut]} (enregistré dans Notion)"
                    st.rerun()

    with st.expander("Décisions déjà prises — remettre une exigence à valider"):
        traitees = ex[~ex[c["statut"]].apply(lambda s: est_a_valider(s, statuts))]
        if traitees.empty:
            st.caption("Aucune décision pour l'instant.")
        else:
            j = st.selectbox("Exigence", traitees.index,
                             format_func=lambda k: f"{traitees.loc[k, c['id']]} — {traitees.loc[k, c['statut']]}",
                             key="rouvrir")
            motif = st.text_input("Motif", key="motif_rouvrir")
            if st.button("Remettre à valider"):
                if not relecteur or not motif.strip():
                    st.error("Nom du relecteur et motif requis.")
                else:
                    maj_page(traitees.loc[j, "_page_id"], {c["statut"]: p_select(statuts["a_valider"])})
                    journaliser({
                        "exigence": traitees.loc[j, c["id"]], "page_id": traitees.loc[j, "_page_id"],
                        "relecteur": relecteur, "decision": "reouverture", "commentaire": motif.strip(),
                        "avant": {"statut": traitees.loc[j, c["statut"]]}, "apres": {"statut": statuts["a_valider"]},
                    })
                    st.session_state["message"] = "Exigence remise à valider."
                    st.rerun()

    with st.expander("Journal des décisions"):
        try:
            lignes = [json.loads(x) for x in FICHIER_JOURNAL.read_text(encoding="utf-8").splitlines() if x.strip()]
        except OSError:
            lignes = []
        if lignes:
            st.dataframe(
                pd.DataFrame(lignes)[["horodatage", "exigence", "relecteur", "decision", "commentaire"]].iloc[::-1],
                hide_index=True, use_container_width=True,
            )
        else:
            st.caption("Journal vide.")


def _onglet_gouvernance(relecteur: str) -> None:
    gouv = lire_json(FICHIER_GOUVERNANCE)
    if not gouv:
        st.info("Aucune proposition de gouvernance : lance `npm run agent`.")
        return

    reco = gouv["propositionIA"]
    st.markdown(f"### Proposition de l'agent : **{reco['recommandation']}** (confiance {pourcent(reco['confiance'])})")
    st.write(reco["justification"])
    st.markdown(f"**Répartition** : {reco['repartition']}")
    compte = gouv.get("repartitionCalculee", {})
    st.caption(f"Rattachement calculé — TOGAF : {compte.get('TOGAF', 0)} · ITIL : {compte.get('ITIL', 0)}")

    st.dataframe(
        pd.DataFrame(reco["criteres"]).rename(columns={
            "critere": "Critère", "togaf": "TOGAF", "itil": "ITIL", "avantage": "Avantage"}),
        hide_index=True, use_container_width=True,
    )
    for p in reco["pointsDeVigilance"]:
        st.markdown(f"- ⚠️ {p}")

    st.divider()
    decision = lire_json(FICHIER_DECISION) or {}
    actuelle = decision.get("decisionHumaine")
    if actuelle:
        st.success(f"Décision actuelle : **{actuelle}** — {decision.get('decideur') or '?'} "
                   f"({decision.get('date') or '?'}). {decision.get('justification') or ''}")
    else:
        st.warning("Aucune décision humaine pour l'instant.")

    cadres = ["TOGAF", "ITIL", "Hybride"]
    with st.form("form_gouvernance"):
        choix = st.radio("Cadre retenu (décision humaine)", cadres, horizontal=True,
                         index=cadres.index(actuelle) if actuelle in cadres else cadres.index(reco["recommandation"]))
        justification = st.text_area("Justification de ta décision", value=decision.get("justification") or "")
        envoyer = st.form_submit_button("Enregistrer ma décision")

    if envoyer:
        if not relecteur or not justification.strip():
            st.error("Nom du relecteur (barre latérale) et justification requis.")
        else:
            nouvelle = {
                "_aide": "Rempli depuis le cockpit par un humain. Relance `npm run agent` pour mettre à jour le plan et l'Excel.",
                "decisionHumaine": choix,
                "decideur": relecteur,
                "date": date.today().isoformat(),
                "justification": justification.strip(),
            }
            FICHIER_DECISION.parent.mkdir(parents=True, exist_ok=True)
            FICHIER_DECISION.write_text(json.dumps(nouvelle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            journaliser({"exigence": None, "relecteur": relecteur, "decision": f"gouvernance:{choix}",
                         "commentaire": justification.strip(), "avant": {"decisionHumaine": actuelle}, "apres": {"decisionHumaine": choix}})
            st.success("Décision enregistrée. Relance `npm run agent` pour l'intégrer au plan et à l'Excel.")


# ==================================================
# Vue 4 — Pilotage et échéances
# ==================================================

def vue_pilotage() -> None:
    st.header("Pilotage et échéances")
    ex, c, statuts = contexte()
    if ex.empty:
        st.info("Aucune donnée : lance d'abord `npm run agent`.")
        return

    total = len(ex)
    nb_valides = int((ex[c["statut"]].apply(norm).isin([norm(statuts["valide"]), norm(statuts["corrige"])])).sum())
    nb_rejetes = int((ex[c["statut"]].apply(norm) == norm(statuts["rejete"])).sum())
    nb_attente = int(ex[c["statut"]].apply(lambda s: est_a_valider(s, statuts)).sum())

    k1, k2, k3, k4 = st.columns(4)
    k1.metric("Exigences", total)
    k2.metric("Validées", f"{nb_valides} ({nb_valides / total:.0%})")
    k3.metric("À valider", nb_attente)
    k4.metric("Rejetées", nb_rejetes)

    gauche, droite = st.columns(2)
    with gauche:
        st.subheader("Exigences par statut")
        st.bar_chart(ex[c["statut"]].replace("", "—").value_counts())
    with droite:
        st.subheader("Criticité × statut")
        st.dataframe(pd.crosstab(ex[c["criticite"]].replace("", "—"), ex[c["statut"]].replace("", "—")),
                     use_container_width=True)

    # ----- Actions et échéances -----
    st.subheader("Lots d'action et échéances")
    actions = charger(DB["actions"])
    if actions.empty:
        st.caption("Aucun lot d'action.")
    else:
        col_titre = colonne_titre(DB["actions"])
        col_ech = colonne(actions, "Échéance", "Echeance")
        col_resp = colonne(actions, "Responsable")
        col_rel = colonne(actions, "Exigences Traitées")

        base = pd.DataFrame({
            "Action": actions[col_titre],
            "Échéance": pd.to_datetime(actions[col_ech], errors="coerce").dt.date if col_ech else None,
            "Responsable": actions[col_resp] if col_resp else "",
            "Exigences liées": actions[col_rel].apply(len) if col_rel else 0,
        })
        base.index = actions["_page_id"]

        aujourdhui = date.today()
        avec = base["Échéance"].notna()
        en_retard = int((base.loc[avec, "Échéance"] < aujourdhui).sum())
        a_30j = int(((base.loc[avec, "Échéance"] >= aujourdhui) &
                     (base.loc[avec, "Échéance"] <= aujourdhui.fromordinal(aujourdhui.toordinal() + 30))).sum())

        m1, m2, m3, m4 = st.columns(4)
        m1.metric("Actions", len(base))
        m2.metric("Sans échéance", int((~avec).sum()))
        m3.metric("En retard", en_retard)
        m4.metric("À 30 jours", a_30j)

        st.caption("Renseigne les échéances directement dans le tableau, puis enregistre (écrit dans Notion).")
        edite = st.data_editor(
            base, use_container_width=True, hide_index=True, num_rows="fixed",
            disabled=["Action", "Responsable", "Exigences liées"],
            column_config={"Échéance": st.column_config.DateColumn("Échéance", format="DD/MM/YYYY")},
            key="editeur_actions",
        ) if col_ech else None

        if col_ech is None:
            st.caption("Colonne « Échéance » absente de la base des actions.")
        elif st.button("Enregistrer les échéances"):
            changements = 0
            for page_id in base.index:
                avant, apres = base.loc[page_id, "Échéance"], edite.loc[page_id, "Échéance"]
                avant = None if pd.isna(avant) else avant
                apres = None if pd.isna(apres) else apres
                if avant != apres:
                    maj_page(page_id, {col_ech: p_date(apres)})
                    changements += 1
            st.success(f"{changements} échéance(s) mise(s) à jour dans Notion.")
            st.rerun()

    # ----- Échéances réglementaires issues des textes -----
    if c["echeance"]:
        reglementaires = ex[ex[c["echeance"]].astype(str).str.strip() != ""]
        st.subheader(f"Échéances réglementaires citées ({len(reglementaires)})")
        if reglementaires.empty:
            st.caption("Aucune échéance relevée dans les textes.")
        else:
            st.dataframe(
                reglementaires[[c["id"], c["article"], c["criticite"], c["echeance"], c["statut"]]]
                .rename(columns={c["id"]: "Exigence", c["article"]: "Article", c["criticite"]: "Criticité",
                                 c["echeance"]: "Échéance", c["statut"]: "Statut"}),
                hide_index=True, use_container_width=True,
            )

    # ----- Risques et contrôles -----
    g2, d2 = st.columns(2)
    risques = charger(DB["risques"])
    with g2:
        st.subheader("Risques : impact × probabilité")
        if risques.empty:
            st.caption("Aucun risque.")
        else:
            ci, cp = colonne(risques, "Impact"), colonne(risques, "Probabilité", "Probabilite")
            st.dataframe(pd.crosstab(risques[ci], risques[cp]), use_container_width=True)

    controles = charger(DB["controles"])
    with d2:
        st.subheader("Contrôles par état")
        if controles.empty:
            st.caption("Aucun contrôle.")
        else:
            ce = colonne(controles, "État", "Etat")
            st.bar_chart(controles[ce].replace("", "—").value_counts())


# ==================================================
# Application
# ==================================================

st.set_page_config(page_title="Cockpit GRC", page_icon="🛡️", layout="wide")

if not TOKEN:
    st.error("NOTION_API_KEY est absent du fichier .env à la racine du projet.")
    st.stop()

with st.sidebar:
    st.title("🛡️ Cockpit GRC")
    vue = st.radio("Vue", ["Fil de veille", "Textes et matrices", "Validation humaine", "Pilotage et échéances"])
    st.divider()
    relecteur = st.text_input("Ton nom (relecteur)", key="relecteur", help="Inscrit dans le journal de validation.").strip()
    if st.button("🔄 Actualiser depuis Notion"):
        charger.clear()
        analyses_locales.clear()
        st.rerun()

try:
    if vue == "Fil de veille":
        vue_fil_de_veille()
    elif vue == "Textes et matrices":
        vue_textes_matrices()
    elif vue == "Validation humaine":
        vue_validation(relecteur)
    else:
        vue_pilotage()
except RuntimeError as erreur:
    st.error(str(erreur))