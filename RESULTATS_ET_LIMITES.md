# Résultats et limites

## Résumé

L'agent lit un texte réglementaire (test : DORA, article 28), en extrait des exigences structurées et vérifiables,
les enregistre dans Notion, génère les matrices GRC, propose un cadre de gouvernance et soumet le tout à une
validation humaine (cockpit Streamlit ou serveur MCP). Principe directeur : **l'IA propose, l'humain tranche**.

## Résultats obtenus

| Élément | Résultat |
|---|---|
| Exigences extraites (DORA, art. 28) | 28, chacune avec article, citation, criticité, confiance |
| Citations retrouvées dans le texte source | 28 sur 28 |
| Contrôles / risques / actions proposés | 25 / 28 / 25, liés aux exigences dans Notion |
| Idempotence | Un second lancement crée 0 élément (tout est ignoré ou servi par le cache) |
| Matrices | M1 Traçabilité, M2 Impact, M3 Couverture, M4 Risque, M5 Jurisprudence (voir limites), plus 2 feuilles de gouvernance |
| Gouvernance | Proposition de l'agent : **Hybride** (TOGAF et ITIL). Décision humaine : cadre retenu, décideur, date] |
| Validation humaine | Cockpit Streamlit (valider / corriger / rejeter) et serveur MCP, avec journal nominatif |
| Notion | 6 bases liées entre elles ; le statut de validation n'est jamais écrasé par l'agent |

Les exigences, matrices et le plan de gouvernance partagent les mêmes identifiants (`EX-DORA-28-P<n>-<nn>`).

## Fonctionnement de la fiabilité

- Les identifiants, articles et paragraphes sont calculés par le code, pas par l'IA.
- Chaque citation est vérifiée dans le texte source ; si elle n'est pas retrouvée, la confiance est plafonnée à 0,3
  et le cockpit l'affiche en tête de la file de relecture.
- Les réponses de l'IA sont mises en cache : mêmes entrées, mêmes sorties, pas de doublons d'un lancement à l'autre.
- Les rattachements de gouvernance sont contraints à une liste fermée (phases TOGAF, pratiques ITIL 4) ; une réponse
  hors liste est redemandée une fois, puis signalée comme « non rattachée ».
- Toute décision (exigence, gouvernance) est nominative et tracée dans `data/journal_validation.jsonl`.

## Limites connues

1. **Un seul texte, un seul article testé.** Pas de multi-sources (EUR-Lex, Légifrance), pas de détection de
   changement entre deux versions d'un texte, pas de planification des lancements.
2. **Matrice M5 (jurisprudence) vide.** Aucune recherche de décisions n'est réalisée ; la base Jurisprudence de
   Notion et la feuille M5 sont créées mais restent sans contenu.
3. **Pas de verdict d'applicabilité** : l'agent n'indique pas si le texte s'applique à l'organisation.
4. **Profil d'organisation fictif** (`data/organisation.json`, « Atlas Finance ») : les matrices M2 (impact),
   M3 (couverture) et M4 (risque) en dépendent et n'ont pas de valeur réelle pour une vraie organisation.
5. **Extraction par LLM (gpt-4o-mini).** Le découpage d'une obligation en exigences peut être trop fin ou trop
   large. Les contrôles, risques et actions sont des propositions génériques, souvent une par exigence. Une relecture
   humaine est indispensable avant tout usage.
6. **Citation vérifiée ne veut pas dire interprétation juste** : la vérification prouve la présence du texte cité,
   pas l'exactitude de la qualification de l'obligation.
7. **Numérotation des paragraphes.** Le texte de test n'a pas de numérotation officielle : l'article est indiqué sans
   paragraphe (« Article 28 »).
8. **L'Excel est construit à partir de l'extraction du lancement en cours**, pas à partir de l'état de Notion : une
   correction faite dans le cockpit n'apparaît dans l'Excel que si elle est reportée dans l'extraction.
9. **Intégration Notion.** Le serveur MCP est réalisé (5 outils, validation nominative). Les **Workers Notion ne sont
   pas réalisés** : ils exigent un forfait Business ou supérieur, et le projet utilise un forfait gratuit.
10. **Sécurité.** Pas d'authentification dans le cockpit : le relecteur est un nom saisi librement. Les
    identifiants des bases Notion sont définis dans le code (surchargeables par `.env`).
11. **Pas de tests automatisés.** La vérification s'est faite par exécutions répétées (idempotence, cache) et par
    un test d'installation sur un clone neuf.

## Pistes d'amélioration

Verdict d'applicabilité ; recherche de jurisprudence (Judilibre) pour alimenter M5 ; ingestion multi-sources avec
détection de changement et exécution planifiée ; profil d'organisation réel ; génération de l'Excel depuis Notion ;
tests automatisés ; Workers Notion avec un forfait compatible.