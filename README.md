# Agent de veille GRC et législative

Agent IA qui lit un texte réglementaire, en extrait les obligations (avec article et citation), les enregistre dans
Notion, génère les matrices GRC M1 à M5, propose un cadre de gouvernance (TOGAF / ITIL / hybride) et laisse
l'humain valider, soit dans un cockpit Streamlit, soit via un serveur MCP.

> **L'IA propose, l'humain tranche.** Le statut de validation d'une exigence et le choix du cadre de gouvernance
> ne sont jamais décidés par l'agent. Chaque décision humaine est nominative et tracée.

## Architecture

```
data/document_source.txt ─┐
data/organisation.json ───┤
                          ▼
              src/agent.ts  (AI SDK + Zod, gpt-4o-mini)
   découpage article → paragraphe → passage · extraction · vérification des citations
   analyse d'impact · proposition de gouvernance · anti-doublons · cache
        │                    │                         │
        ▼                    ▼                         ▼
   Notion (6 bases)   data/matrices/Matrices_GRC.xlsx   data/exigences.json
                      data/plan_gouvernance.md          data/gouvernance.json
        ▲  ▲
        │  └──────────────── src/mcp-server.ts  (serveur MCP, stdio)
        │ lecture + écriture des décisions humaines
 cockpit/app.py  (Streamlit, 4 vues)
        └──►  data/journal_validation.jsonl  (journal des décisions, cockpit et MCP)
```

Principe de conception : le code déterministe encadre l'IA. Les IDs, les articles et les paragraphes sont calculés
par le code ; chaque citation est vérifiée dans le texte source (sinon confiance plafonnée à 0,3) ; les réponses de
l'IA sont mises en cache, ce qui rend les relances idempotentes (aucun doublon).

## Installation

Prérequis : Node.js 20+, Python 3.10+, une intégration Notion partagée avec les 6 bases, une clé OpenAI.

```powershell
npm install
npm install @modelcontextprotocol/sdk
copy .env.example .env            # puis renseigner NOTION_API_KEY et OPENAI_API_KEY
python -m pip install -r cockpit/requirements.txt
```

Sous macOS / Linux : `cp .env.example .env` et `python3`.

Scripts à avoir dans `package.json` :

```json
"scripts": {
  "agent": "tsx src/agent.ts",
  "mcp": "tsx src/mcp-server.ts"
}
```

Les 6 bases Notion attendues : Textes, Exigences, Contrôles, Risques, Jurisprudence, Lots d'action
(propriétés détectées automatiquement ; le détail est vérifié à chaque lancement).
Les identifiants des bases sont définis en tête de `src/agent.ts` (objet `DB`) ; le cockpit et le serveur MCP les
reprennent et acceptent des surcharges via `.env` (`NOTION_DB_EXIGENCES`, etc.).

## Utilisation

Toutes les commandes se lancent **depuis la racine du projet**.

1. Placer le texte dans `data/document_source.txt` (en-tête `SOURCE : …` puis lignes `Article N — Titre`).
2. `npm run agent` : extraction, écriture dans Notion, matrices, proposition de gouvernance.
3. `python -m streamlit run cockpit/app.py` : relire, valider, corriger ou rejeter les exigences ; enregistrer la
   décision de gouvernance. (`python -m` évite le problème de PATH sous Windows.)
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
| 6 | Consulter une exigence avec son statut, la valider | Cockpit (vues 2 et 3) |

## Cockpit Streamlit

| Vue | Contenu |
|---|---|
| Fil de veille | Textes suivis, liens officiels, exigences à valider, activité récente |
| Textes et matrices | Exigences par texte avec filtres, fiche détaillée (citation, impact, éléments liés), aperçu et téléchargement de l'Excel |
| Validation humaine | File de relecture (les moins fiables d'abord), valider / corriger / rejeter, réouverture, décision de gouvernance |
| Pilotage et échéances | Indicateurs par statut et criticité, échéances des lots d'action modifiables, risques, contrôles |

Le nom du relecteur (barre latérale) est obligatoire pour décider ; un rejet exige un commentaire.

## Serveur MCP (Notion)

`src/mcp-server.ts` expose la base GRC à n'importe quel client MCP (MCP Inspector, Cursor, VS Code, Claude Desktop,
ou un agent construit avec l'AI SDK / l'Agents SDK d'OpenAI) en stdio. Il n'appelle aucun modèle : il lit et écrit
dans Notion.

Outils : `lister_exigences`, `consulter_exigence`, `decider_exigence` (valider / rejeter, relecteur nommé obligatoire,
tracé dans le journal avec `source: mcp`), `proposition_gouvernance` (lecture seule), `synthese_pilotage`.

Tester sans compte supplémentaire avec MCP Inspector :

```powershell
npx @modelcontextprotocol/inspector npx tsx src/mcp-server.ts
```

Puis **Connect → Tools → List Tools**.

Configuration d'un client qui lit un fichier JSON (exemple Claude Desktop, `claude_desktop_config.json`) :

```json
{
  "mcpServers": {
    "grc-veille": {
      "command": "npx",
      "args": ["tsx", "src/mcp-server.ts"],
      "cwd": "C:\\Users\\Maxwe\\Desktop\\Agent-GRC"
    }
  }
}
```

Le serveur doit être lancé depuis la racine du projet (il y cherche `.env` et `data/`).

**Workers Notion** : non réalisés. Ils exigent un forfait Business ou supérieur, et le projet tourne sur un forfait gratuit.

## Modules

| Module | Contenu | État |
|---|---|---|
| 1 Veille multi-sources | Un fichier local ; pas de multi-sources, de détection de changement ni de planification | Partiel |
| 2 Analyse | Obligations, échéances, sanctions, destinataires, impact, confiance, citations vérifiées | Fait ; applicabilité et jurisprudence non faites |
| 3 Notion | 6 bases liées, idempotence, serveur MCP | Fait ; Workers non faits (forfait) |
| 4 Gouvernance | Proposition TOGAF / ITIL / hybride, rattachement des exigences, décision humaine | Fait |
| 5 Cockpit | 4 vues, validation persistée dans Notion, journal | Fait |

## Matrices

M1 Traçabilité · M2 Impact · M3 Couverture · M4 Risque (gravité × vraisemblance) · M5 Jurisprudence, plus deux
feuilles de gouvernance. Toutes partagent les mêmes IDs d'exigence (`EX-<CODE>-<passage>-<n°>`).

## Résultats et limites 

Voir `RESULTATS_ET_LIMITES.md`.