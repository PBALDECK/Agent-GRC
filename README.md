# Agent-GRC

# équipe : Jafari Ramin, Oumam Anass, Bougaa Mohammed-achraf, Baldeck Pierre

# Agent de veille GRC et législative

Agent IA qui lit un texte réglementaire, en extrait les obligations (avec article et citation), les enregistre dans
Notion, génère les matrices GRC M1 à M5, propose un cadre de gouvernance (TOGAF / ITIL / hybride) et laisse
l'humain valider dans un cockpit Streamlit.

> **L'IA propose, l'humain tranche.** Le statut de validation d'une exigence et le choix du cadre de gouvernance
> ne sont jamais décidés par l'agent.

## Architecture

```
data/document_source.txt ─┐
data/organisation.json ───┤
                          ▼
              src/agent.ts  (AI SDK + Zod, gpt-4o-mini)
   découpage article → paragraphe → passage · extraction · vérification des citations
   analyse d'impact · propositions de gouvernance · anti-doublons · cache
        │                    │                         │
        ▼                    ▼                         ▼
   Notion (6 bases)   data/matrices/Matrices_GRC.xlsx   data/exigences.json
                      data/plan_gouvernance.md          data/gouvernance.json
        ▲
        │ lecture + écriture des décisions humaines
 cockpit/app.py  (Streamlit, 4 vues)  ──►  data/journal_validation.jsonl
```

Principe de conception : le code déterministe encadre l'IA. Les IDs, les articles et les paragraphes sont calculés
par le code ; chaque citation est vérifiée dans le texte source (sinon confiance plafonnée à 0,3) ; les réponses de
l'IA sont mises en cache, ce qui rend les relances idempotentes (aucun doublon).

## Installation

Prérequis : Node.js 20+, Python 3.10+, une intégration Notion partagée avec les 6 bases, une clé OpenAI.

```bash
npm install
cp .env.example .env        # puis renseigner NOTION_API_KEY et OPENAI_API_KEY
pip install -r cockpit/requirements.txt
```

Les 6 bases Notion attendues : Textes, Exigences, Contrôles, Risques, Jurisprudence, Lots d'action
(propriétés détectées automatiquement ; le détail est vérifié à chaque lancement).
Les identifiants des bases sont définis en tête de `src/agent.ts` (objet `DB`) et dans `cockpit/app.py`.

## Utilisation

1. Placer le texte dans `data/document_source.txt` (en-tête `SOURCE : …` puis lignes `Article N — Titre`).
2. `npm run agent` : extraction, écriture dans Notion, matrices, proposition de gouvernance.
3. `streamlit run cockpit/app.py` : relire, valider, corriger ou rejeter les exigences ; enregistrer la décision de gouvernance.
4. Relancer `npm run agent` après une décision de gouvernance pour mettre à jour le plan et l'Excel.

Variables : `CODE_TEXTE` (ex. DORA), `FORCER_EXTRACTION=1` (ignore le cache). Après modification d'un prompt ou d'un
schéma, incrémenter `VERSION_PROMPT` dans `src/agent.ts`.

## Parcours minimal (6 étapes)

| # | Étape | Où |
|---|---|---|
| 1 | Charger un texte | `data/document_source.txt` |
| 2 | Extraire les obligations | `npm run agent` |
| 3 | Exigences structurées avec articles | Notion, base Exigences |
| 4 | Première matrice | `data/matrices/Matrices_GRC.xlsx` |
| 5 | Sauvegarde dans Notion | 6 bases liées |
| 6 | Consulter une exigence avec son statut | Cockpit, vues 2 et 3 |

## Modules

| Module | Contenu | État |
|---|---|---|
| 1 Veille multi-sources | Un fichier local ; pas de détection de changement ni de planification | Partiel |
| 2 Analyse | Obligations, échéances, sanctions, destinataires, impact, confiance, citations vérifiées | Fait ; applicabilité et jurisprudence non faites |
| 3 Notion | 6 bases liées, idempotence | Fait ; MCP / workers non faits |
| 4 Gouvernance | Proposition TOGAF / ITIL / hybride, rattachement des exigences, décision humaine | Fait |
| 5 Cockpit | 4 vues, validation persistée dans Notion, journal | Fait |

## Matrices

M1 Traçabilité · M2 Impact · M3 Couverture · M4 Risque (gravité × vraisemblance) · M5 Jurisprudence, plus deux
feuilles de gouvernance. Toutes partagent les mêmes IDs d'exigence (`EX-<CODE>-<passage>-<n°>`).

Résultats et limites : voir `RESULTATS_ET_LIMITES.md`.