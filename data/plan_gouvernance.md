# Plan de gouvernance (proposition de l'agent)

**Statut de la décision :** ⏳ EN ATTENTE DE DÉCISION HUMAINE

> L'IA propose, l'humain tranche : le cadre retenu est celui inscrit dans `data/decision_gouvernance.json`.

## Proposition de l'IA : Hybride (confiance 80 %)

Atlas Finance doit gérer à la fois des exigences réglementaires liées à l'architecture d'entreprise (TOGAF) et à la gestion des services (ITIL). Un cadre hybride permettra de structurer la gouvernance tout en assurant une exploitation efficace des services TIC.

**Répartition des exigences :** Les exigences EX-DORA-28-P1-01 à EX-DORA-28-P1-06 et EX-DORA-28-P2-01 à EX-DORA-28-P2-12 relèvent de TOGAF pour la gouvernance et la cartographie. Les exigences EX-DORA-28-P2-01 à EX-DORA-28-P3-06 relèvent d'ITIL pour la gestion des services et des incidents.

Rattachement calculé : 7 exigence(s) côté TOGAF, 22 côté ITIL.

## Comparaison TOGAF / ITIL

| Critère | TOGAF | ITIL | Avantage |
|---|---|---|---|
| Nature des exigences | Structure et cartographie des systèmes d'information | Gestion des services et incidents | Équivalent |
| Horizon temporel | Long terme avec une vision stratégique | Court terme avec une gestion opérationnelle | ITIL |
| Maturité | Nécessite une maturité élevée en architecture | Peut être mis en œuvre progressivement | ITIL |
| Parties prenantes | Impliquent des architectes et des décideurs | Impliquent des équipes opérationnelles et de support | Équivalent |
| Effort de mise en œuvre | Peut être complexe et long | Plus rapide à mettre en place | ITIL |

## Points de vigilance

- Risque de complexité dans la mise en œuvre d'un cadre hybride
- Nécessité d'une coordination efficace entre les équipes d'architecture et d'exploitation

## Rattachement des exigences

### ITIL — Gestion des fournisseurs (Supplier management)

- **EX-DORA-28-P1-01** (Article 28) — L'organisation s'assure que les obligations contractuelles sont respectées par les prestataires de services.
- **EX-DORA-28-P1-05** (Article 28) — L'organisation documente clairement les accords contractuels en fonction de leur criticité.
- **EX-DORA-28-P2-02** (Article 28) — L'organisation informe les autorités compétentes de tout projet d'accord concernant des services TIC critiques.
- **EX-DORA-28-P2-03** (Article 28) — L'organisation évalue si un accord contractuel concerne des services TIC critiques avant de le conclure.
- **EX-DORA-28-P2-06** (Article 28) — L'organisation fait preuve de diligence envers les prestataires tiers en évaluant leurs capacités et leur conformité.
- **EX-DORA-28-P2-11** (Article 28) — L'organisation vérifie que les auditeurs possèdent les compétences requises pour les évaluations et audits.
- **EX-DORA-28-P2-12** (Article 28) — L'organisation s'assure que les accords contractuels peuvent être résiliés dans certaines circonstances.

### ITIL — Gestion des risques (Risk management)

- **EX-DORA-28-P1-02** (Article 28) — L'organisation évalue et gère les risques associés aux prestataires tiers de services TIC.
- **EX-DORA-28-P1-03** (Article 28) — L'organisation adopte et révise régulièrement une stratégie de gestion des risques pour les prestataires tiers.
- **EX-DORA-28-P2-04** (Article 28) — L'organisation évalue les conditions de surveillance avant de finaliser un accord contractuel.
- **EX-DORA-28-P2-05** (Article 28) — L'organisation identifie et évalue les risques liés aux accords contractuels en mettant en œuvre des processus de gestion des risques.
- **EX-DORA-28-P2-07** (Article 28) — L'organisation identifie et évalue les conflits d'intérêts potentiels dans les accords contractuels.
- **EX-DORA-28-P2-10** (Article 28) — L'organisation détermine la fréquence des audits sur la base d'une approche fondée sur les risques.

### ITIL — Gestion des actifs informatiques (IT asset management)

- **EX-DORA-28-P1-04** (Article 28) — L'organisation maintient un registre à jour des accords contractuels avec les prestataires de services TIC.
- **EX-DORA-28-P2-01** (Article 28) — L'organisation met à disposition le registre d'informations sur demande des autorités compétentes.

### ITIL — Gestion des relations (Relationship management)

- **EX-DORA-28-P1-06** (Article 28) — L'organisation communique annuellement avec les autorités compétentes sur les nouveaux accords de services TIC.

### ITIL — Gestion de la sécurité de l'information (Information security management)

- **EX-DORA-28-P2-08** (Article 28) — L'organisation s'assure que les prestataires respectent des normes adéquates de sécurité de l'information avant de conclure des accords.
- **EX-DORA-28-P2-09** (Article 28) — L'organisation prend en compte les normes de sécurité les plus élevées avant de conclure des accords pour des fonctions critiques.

### ITIL — Gestion de la continuité de service (Service continuity management)

- **EX-DORA-28-P3-01** (Article 28) — L'organisation met en place des stratégies de sortie pour les services TIC soutenant des fonctions critiques.
- **EX-DORA-28-P3-02** (Article 28) — L'organisation s'assure qu'elle peut se retirer des accords contractuels sans perturber ses activités.
- **EX-DORA-28-P3-03** (Article 28) — L'organisation documente et teste régulièrement ses plans de sortie pour assurer leur efficacité.
- **EX-DORA-28-P3-05** (Article 28) — L'entité met en place des mesures d'urgence pour garantir la continuité des activités en cas de défaillance des prestataires.

### TOGAF — Phase E — Opportunités et solutions

- **EX-DORA-28-P3-04** (Article 28) — L'entité définit des solutions alternatives et élabore des plans de transition pour les services TIC concernés.

### TOGAF — Phase B — Architecture métier

- **EX-DORA-28-P3-06** (Article 28) — Les AES élaborent des projets de normes techniques d'exécution pour les accords contractuels relatifs aux services TIC.
- **EX-DORA-28-P3-07** (Article 28) — Les AES développent des projets de normes techniques de réglementation pour définir les stratégies relatives aux services TIC.
- **EX-DORA-28-P4-01** (Article 28) — Les AES prennent en compte la taille et le profil de risque de l'entité lors de l'élaboration des normes techniques.
- **EX-DORA-28-P4-02** (Article 28) — Les AES considèrent la nature et la complexité des services lors de l'élaboration des normes techniques.

### TOGAF — Phase H — Gestion des changements d'architecture

- **EX-DORA-28-P4-03** (Article 28) — Les AES soumettent les projets de normes techniques de réglementation à la Commission avant la date limite.
- **EX-DORA-28-P4-04** (Article 28) — La Commission adopte des normes techniques de réglementation pour compléter le règlement.
