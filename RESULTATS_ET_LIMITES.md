# Résultats et limites

## Résultats obtenus (texte de test : DORA, article 28)

- 4 passages analysés, **28 exigences** structurées avec article, citation, criticité, confiance.
- 25 contrôles, 28 risques et 25 actions proposés et liés aux exigences dans Notion.
- Citations : toutes retrouvées dans le texte source.
- Idempotence : un second lancement crée 0 élément (tout est ignoré ou servi par le cache).
- Matrices M1 à M5 générées en Excel, plus la gouvernance. Proposition de l'agent : **Hybride**, la décision
  finale restant humaine (`data/decision_gouvernance.json`).
- Cockpit Streamlit : validation, correction et rejet persistés dans Notion et tracés dans un journal.

## Limites connues

1. **Un seul texte, un seul article testé.** Pas de multi-sources (EUR-Lex, Légifrance), pas de détection de
   changement entre versions, pas de planification.
2. **Pas de verdict d'applicabilité** du texte à l'organisation.
3. **Pas de recherche de jurisprudence** : la base et la matrice M5 restent vides.
4. **Profil d'organisation fictif** (`data/organisation.json`, « Atlas Finance ») : les matrices M2 à M4
   (impact, couverture, risque) en dépendent et n'ont pas de valeur réelle.
5. **Extraction par LLM (gpt-4o-mini)** : le découpage d'une obligation en exigences peut être trop fin ou trop
   large ; les contrôles, risques et actions sont des propositions génériques à relire. La relecture humaine est
   indispensable avant usage.
6. **Citations vérifiées par inclusion de texte** : une citation retrouvée prouve sa présence, pas la justesse
   de l'interprétation.
7. **Numérotation des paragraphes** : le texte de test n'a pas de numérotation officielle, donc l'article est
   indiqué sans § (« Article 28 »).
8. **Excel construit à partir de l'extraction du lancement en cours**, pas à partir de l'état de Notion : une
   correction faite dans le cockpit n'apparaît dans l'Excel que si elle est reportée dans l'extraction.
9. **Cockpit** : pas d'authentification ; le relecteur est un nom saisi.
10. **Pas de tests automatisés.**
