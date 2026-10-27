import "dotenv/config";
import { Client } from "@notionhq/client";
import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import process from "node:process";

// ==================================================
// 1. CONFIGURATION
// ==================================================

if (!process.env.NOTION_API_KEY) {
  throw new Error("NOTION_API_KEY est absent du fichier .env");
}

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY est absent du fichier .env");
}

const notion = new Client({
  auth: process.env.NOTION_API_KEY,
  notionVersion: "2025-09-03",
});

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DB = {
  textes: "4066959030358077997bc05b06462974",
  exigences: "40669590303580adb9c2dce8aa09e4f0",
  controles: "4066959030358043a916daeaf015b574",
  risques: "40669590303580b186cefcca7e7b8d14",
  jurisprudence: "40669590303580cb99c8c38d0cfb0fe8",
  actions: "40669590303580698113e40cb801a2b4",
};

const SOURCE_FILE = "./data/document_source.txt";

const dataSourceIds = new Map<string, string>();

// ==================================================
// 2. SCHÉMA D'EXTRACTION
// ==================================================

const ExtractionSchema = z.object({
  texte: z.object({
    nom: z.string().min(1),
    source: z.string().min(1),
    url: z.string().nullable(),
    dateEntreeEnVigueur: z.string().nullable(),
  }),

  exigences: z.array(
    z.object({
      id: z.string().min(1),
      article: z.string().min(1),
      description: z.string().min(1),
      criticite: z.string().min(1),
    }),
  ).min(1),

  controles: z.array(
    z.object({
      nom: z.string().min(1),
      type: z.string().min(1),
      etat: z.string().min(1),
      exigences: z.array(z.string()),
    }),
  ),

  risques: z.array(
    z.object({
      nom: z.string().min(1),
      impact: z.string().min(1),
      probabilite: z.string().min(1),
      exigence: z.string().min(1),
    }),
  ),

  jurisprudence: z.array(
    z.object({
      nom: z.string().min(1),
      juridiction: z.string().min(1),
      resume: z.string().min(1),
      exigences: z.array(z.string()),
    }),
  ),

  actions: z.array(
    z.object({
      nom: z.string().min(1),
      exigences: z.array(z.string()),
    }),
  ),
});

type Extraction = z.infer<typeof ExtractionSchema>;

// ==================================================
// 3. OUTILS POUR LES PROPRIÉTÉS NOTION
// ==================================================

function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("fr")
    .replace(/[^a-z0-9]/g, "");
}

function propertyNames(db: any): string[] {
  return Object.keys(db.properties ?? {});
}

/**
 * Recherche une propriété à partir de plusieurs noms possibles.
 * La comparaison ignore les accents, la casse et les espaces
 * superflus, notamment les espaces en fin de nom.
 */
function findPropertyName(
  db: any,
  candidates: string[],
  expectedType?: string,
): string {
  const properties = db.properties ?? {};

  for (const candidate of candidates) {
    const actualName = Object.keys(properties).find(
      name => normalizeName(name) === normalizeName(candidate),
    );

    if (
      actualName &&
      (!expectedType || properties[actualName].type === expectedType)
    ) {
      return actualName;
    }
  }

  throw new Error(
    `Propriété introuvable. Noms recherchés : ${candidates.join(", ")}. ` +
    `Type attendu : ${expectedType ?? "quelconque"}. ` +
    `Propriétés disponibles : ${Object.keys(properties).join(", ")}`,
  );
}

/**
 * Détecte automatiquement la propriété titre de la base.
 * Dans les schémas actuels, elle s'appelle généralement "Nom".
 */
function getTitlePropertyName(db: any): string {
  const entry = Object.entries(db.properties ?? {}).find(
    ([, property]: [string, any]) => property.type === "title",
  );

  if (!entry) {
    throw new Error(
      `Aucune propriété de type title trouvée. ` +
      `Propriétés disponibles : ${propertyNames(db).join(", ")}`,
    );
  }

  return entry[0];
}

async function getDatabase(databaseId: string): Promise<any> {
  const database = await notion.databases.retrieve({
    database_id: databaseId,
  });

  const dataSources = (database as any).data_sources;

  if (!dataSources || dataSources.length === 0) {
    throw new Error(
      `Aucune source de données trouvée pour la base ${databaseId}. ` +
      "Vérifie les accès de l'intégration Notion.",
    );
  }

  const dataSourceId = dataSources[0].id;
  dataSourceIds.set(databaseId, dataSourceId);

  const dataSource = await notion.dataSources.retrieve({
    data_source_id: dataSourceId,
  });

  if (!(dataSource as any).properties) {
    throw new Error(
      `Impossible de récupérer les propriétés de la base ${databaseId}.`,
    );
  }

  console.log(
    `  Base ${databaseId} : ${
      Object.keys((dataSource as any).properties).join(", ")
    }`,
  );

  return dataSource;
}

function getSelectOptions(
  db: any,
  propertyCandidates: string[],
): string[] {
  const propertyName = findPropertyName(
    db,
    propertyCandidates,
    "select",
  );

  const property = db.properties[propertyName];
  const options = (property.select?.options ?? []).map(
    (option: { name: string }) => option.name,
  );

  if (options.length === 0) {
    throw new Error(
      `La propriété Select "${propertyName}" ne contient aucune option. ` +
      "Ajoute au moins une option dans Notion avant de relancer le script.",
    );
  }

  return options;
}

function validateSelect(
  value: string,
  options: string[],
  propertyName: string,
): string {
  const match = options.find(
    option =>
      option.toLocaleLowerCase("fr") === value.trim().toLocaleLowerCase("fr"),
  );

  if (!match) {
    throw new Error(
      `Valeur "${value}" invalide pour "${propertyName}". ` +
      `Options disponibles : ${options.join(", ")}`,
    );
  }

  return match;
}

function chooseOption(
  options: string[],
  preferred: string,
): string {
  const match = options.find(
    option =>
      option.toLocaleLowerCase("fr") === preferred.toLocaleLowerCase("fr"),
  );

  return match ?? options[0];
}

// ==================================================
// 4. GESTION DES OPTIONS SELECT
// ==================================================

async function ensureArticleOptions(
  exigencesDb: any,
  articles: string[],
): Promise<void> {
  const propertyName = findPropertyName(
    exigencesDb,
    ["Article"],
    "select",
  );

  const existing = exigencesDb.properties[propertyName].select?.options ?? [];
  const existingNames = new Set(
    existing.map((option: { name: string }) => option.name),
  );

  const additions = [...new Set(
    articles.map(article => article.trim().slice(0, 100)),
  )]
    .filter(article => article && !existingNames.has(article))
    .map(name => ({ name }));

  if (additions.length === 0) {
    console.log("Aucune nouvelle option nécessaire pour Article.");
    return;
  }

  const dataSourceId = dataSourceIds.get(DB.exigences);

  if (!dataSourceId) {
    throw new Error("Source de données de DB_Exigences non initialisée.");
  }

  await notion.dataSources.update({
    data_source_id: dataSourceId,
    properties: {
      [propertyName]: {
        select: {
          options: [...existing, ...additions],
        },
      },
    },
  } as any);

  console.log(
    `${additions.length} nouvelle(s) option(s) ajoutée(s) à ${propertyName}.`,
  );
}

// ==================================================
// 5. HELPERS DE CRÉATION NOTION
// ==================================================

function title(value: string) {
  return [
    {
      text: {
        content: value.slice(0, 2000),
      },
    },
  ];
}

function richText(value: string) {
  return [
    {
      text: {
        content: value.slice(0, 2000),
      },
    },
  ];
}

function select(value: string) {
  return {
    select: {
      name: value,
    },
  };
}

function relation(ids: string[]) {
  return {
    relation: [...new Set(ids)].map(id => ({ id })),
  };
}

function parseDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return undefined;
  }

  const parsed = new Date(`${value}T00:00:00Z`);

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    return undefined;
  }

  return {
    date: {
      start: value,
    },
  };
}

async function createPage(
  databaseId: string,
  properties: Record<string, any>,
) {
  const dataSourceId = dataSourceIds.get(databaseId);

  if (!dataSourceId) {
    throw new Error(
      `Source de données non initialisée pour la base ${databaseId}.`,
    );
  }

  return notion.pages.create({
    parent: {
      type: "data_source_id",
      data_source_id: dataSourceId,
    },
    properties,
  } as any);
}

// ==================================================
// 6. VALIDATION DES RELATIONS
// ==================================================

function validateReferences(extraction: Extraction): void {
  const ids = extraction.exigences.map(item => item.id);

  if (new Set(ids).size !== ids.length) {
    throw new Error("Des ID Exigence sont dupliqués dans l'extraction.");
  }

  const knownIds = new Set(ids);

  for (const control of extraction.controles) {
    control.exigences = control.exigences.filter(id => knownIds.has(id));
  }

  for (const item of extraction.jurisprudence) {
    item.exigences = item.exigences.filter(id => knownIds.has(id));
  }

  for (const item of extraction.actions) {
    item.exigences = item.exigences.filter(id => knownIds.has(id));
  }

  for (const risk of extraction.risques) {
    if (!knownIds.has(risk.exigence)) {
      throw new Error(
        `Le risque "${risk.nom}" référence l'exigence inconnue ` +
        `"${risk.exigence}".`,
      );
    }
  }
}

// ==================================================
// 7. AGENT PRINCIPAL
// ==================================================

async function main(): Promise<void> {
  console.log("1/6 — Lecture des schémas Notion...");

  const [
    textesDb,
    exigencesDb,
    controlesDb,
    risquesDb,
    jurisprudenceDb,
    actionsDb,
  ] = await Promise.all([
    getDatabase(DB.textes),
    getDatabase(DB.exigences),
    getDatabase(DB.controles),
    getDatabase(DB.risques),
    getDatabase(DB.jurisprudence),
    getDatabase(DB.actions),
  ]);

  // Résolution des noms réels de propriétés.
  // Ces noms sont réutilisés au moment de créer les pages.

  const P = {
    textes: {
      titre: getTitlePropertyName(textesDb),
      source: findPropertyName(textesDb, ["Source"], "select"),
      url: findPropertyName(textesDb, ["URL"], "url"),
      date: findPropertyName(
        textesDb,
        ["date", "Date d'Entrée en Vigueur"],
        "date",
      ),
    },

    exigences: {
      titre: findPropertyName(
        exigencesDb,
        ["ID Exigence"],
        "title",
      ),
      article: findPropertyName(exigencesDb, ["Article"], "select"),
      description: findPropertyName(
        exigencesDb,
        ["Description"],
        "rich_text",
      ),
      criticite: findPropertyName(
        exigencesDb,
        ["Criticité"],
        "select",
      ),
      statut: findPropertyName(
        exigencesDb,
        ["Statut"],
        "select",
      ),
      texteOrigine: findPropertyName(
        exigencesDb,
        ["Texte origine", "Texte Origine"],
        "relation",
      ),
    },

    controles: {
      titre: getTitlePropertyName(controlesDb),
      type: findPropertyName(controlesDb, ["Type"], "select"),
      etat: findPropertyName(controlesDb, ["État", "Etat"], "select"),
      exigences: findPropertyName(
        controlesDb,
        ["Exigences Couvertes"],
        "relation",
      ),
    },

    risques: {
      titre: getTitlePropertyName(risquesDb),
      impact: findPropertyName(risquesDb, ["Impact"], "select"),
      probabilite: findPropertyName(
        risquesDb,
        ["Probabilité", "Probabilite"],
        "select",
      ),
      exigence: findPropertyName(
        risquesDb,
        ["Exigence Liée", "Exigence Liee"],
        "relation",
      ),
    },

    jurisprudence: {
      titre: getTitlePropertyName(jurisprudenceDb),
      juridiction: findPropertyName(
        jurisprudenceDb,
        ["Juridiction"],
        "select",
      ),
      resume: findPropertyName(
        jurisprudenceDb,
        ["Résumé decision", "Résumé décision", "Résumé Sanction / Décision"],
        "rich_text",
      ),
      exigences: findPropertyName(
        jurisprudenceDb,
        ["Exigences Impactées", "Exigences Impactees"],
        "relation",
      ),
    },

    actions: {
      titre: getTitlePropertyName(actionsDb),
      responsable: findPropertyName(
        actionsDb,
        ["Responsable"],
        "people",
      ),
      echeance: findPropertyName(
        actionsDb,
        ["Échéance", "Echeance"],
        "date",
      ),
      exigences: findPropertyName(
        actionsDb,
        ["Exigences Traitées"],
        "relation",
      ),
    },
  };

  const options = {
    source: getSelectOptions(textesDb, ["Source"]),
    criticite: getSelectOptions(exigencesDb, ["Criticité"]),
    statut: getSelectOptions(exigencesDb, ["Statut"]),
    typeControle: getSelectOptions(controlesDb, ["Type"]),
    etatControle: getSelectOptions(controlesDb, ["État", "Etat"]),
    impact: getSelectOptions(risquesDb, ["Impact"]),
    probabilite: getSelectOptions(risquesDb, ["Probabilité", "Probabilite"]),
    juridiction: getSelectOptions(jurisprudenceDb, ["Juridiction"]),
  };

  const statutInitial = chooseOption(options.statut, "À valider");

  console.log("Propriétés Notion vérifiées.");
  console.log("Statut initial retenu :", statutInitial);

  console.log("2/6 — Lecture du document source...");

  const document = (await readFile(SOURCE_FILE, "utf8")).trim();

  if (!document) {
    throw new Error(`Le fichier ${SOURCE_FILE} est vide.`);
  }

  console.log("3/6 — Extraction des données GRC avec l'IA...");

  const { object } = await generateObject({
    model: openai("gpt-4o-mini"),
    schema: ExtractionSchema,
    prompt: `
Tu es un assistant GRC spécialisé en conformité réglementaire.

Analyse exclusivement le document fourni et extrais les éléments utiles
aux six bases Notion.

RÈGLES IMPÉRATIVES :
- N'invente ni texte de loi, ni article, ni obligation présentée comme
  une citation exacte, ni décision de justice.
- N'ajoute une jurisprudence que si une décision identifiable est
  explicitement mentionnée dans le document. Sinon, renvoie [].
- Les contrôles, risques et actions sont des propositions d'analyse ;
  ils doivent être cohérents avec les exigences extraites.
- Chaque ID d'exigence doit être unique, par exemple EX-DORA-001.
- Utilise les ID exacts dans les relations.
- Ne fabrique ni responsable ni échéance.
- Pour la date d'entrée en vigueur, renvoie YYYY-MM-DD uniquement si
  la date est explicitement connue, sinon null.
- Pour l'URL, utilise une URL présente dans le document, sinon null.
- Article est un Select. Utilise une référence d'article précise
  si elle est disponible dans le texte.
- Choisis exclusivement parmi les options suivantes pour les Select :

Source : ${options.source.join(" | ")}
Criticité : ${options.criticite.join(" | ")}
Statut : ${statutInitial}
Type de contrôle : ${options.typeControle.join(" | ")}
État du contrôle : ${options.etatControle.join(" | ")}
Impact : ${options.impact.join(" | ")}
Probabilité : ${options.probabilite.join(" | ")}
Juridiction : ${options.juridiction.join(" | ")}

Ne propose pas de valeurs Select qui ne correspondent pas aux options
ci-dessus. Pour Article, une option manquante pourra être ajoutée.
Produis des éléments utiles, précis et sans doublons.

DOCUMENT :
---
${document}
---
`,
  });

  const extraction: Extraction = object;

  validateReferences(extraction);

  console.log("4/6 — Vérification des options et création de la source...");

  await ensureArticleOptions(
    exigencesDb,
    extraction.exigences.map(item => item.article),
  );

  for (const item of extraction.exigences) {
    item.criticite = validateSelect(
      item.criticite,
      options.criticite,
      P.exigences.criticite,
    );
  }

  for (const item of extraction.controles) {
    item.type = validateSelect(
      item.type,
      options.typeControle,
      P.controles.type,
    );

    item.etat = validateSelect(
      item.etat,
      options.etatControle,
      P.controles.etat,
    );
  }

  for (const item of extraction.risques) {
    item.impact = validateSelect(
      item.impact,
      options.impact,
      P.risques.impact,
    );

    item.probabilite = validateSelect(
      item.probabilite,
      options.probabilite,
      P.risques.probabilite,
    );
  }

  for (const item of extraction.jurisprudence) {
    item.juridiction = validateSelect(
      item.juridiction,
      options.juridiction,
      P.jurisprudence.juridiction,
    );
  }

  extraction.texte.source = validateSelect(
    extraction.texte.source,
    options.source,
    P.textes.source,
  );

  // Création du texte source.

  const sourceProperties: Record<string, any> = {
    [P.textes.titre]: {
      title: title(extraction.texte.nom),
    },

    [P.textes.source]: select(extraction.texte.source),
  };

  if (extraction.texte.url) {
    try {
      const parsedUrl = new URL(extraction.texte.url);

      if (["http:", "https:"].includes(parsedUrl.protocol)) {
        sourceProperties[P.textes.url] = {
          url: parsedUrl.toString(),
        };
      }
    } catch {
      console.warn("URL source invalide : elle ne sera pas enregistrée.");
    }
  }

  const effectiveDate = parseDate(
    extraction.texte.dateEntreeEnVigueur,
  );

  if (effectiveDate) {
    sourceProperties[P.textes.date] = effectiveDate;
  }

  const sourcePage = await createPage(
    DB.textes,
    sourceProperties,
  );

  console.log("Source créée :", sourcePage.id);

  console.log("5/6 — Création des exigences...");

  const requirementPageIds = new Map<string, string>();

  for (const item of extraction.exigences) {
    const article = item.article.trim().slice(0, 100);

    const page = await createPage(DB.exigences, {
      [P.exigences.titre]: {
        title: title(item.id),
      },

      [P.exigences.article]: select(article),

      [P.exigences.description]: {
        rich_text: richText(item.description),
      },

      [P.exigences.criticite]: select(item.criticite),

      [P.exigences.statut]: select(statutInitial),

      [P.exigences.texteOrigine]: relation([sourcePage.id]),
    });

    requirementPageIds.set(item.id, page.id);
  }

  const linkedPageIds = (ids: string[]) =>
    ids
      .map(id => requirementPageIds.get(id))
      .filter((id): id is string => Boolean(id));

  console.log(
    "6/6 — Création des contrôles, risques, jurisprudences et actions...",
  );

  for (const item of extraction.controles) {
    await createPage(DB.controles, {
      [P.controles.titre]: {
        title: title(item.nom),
      },

      [P.controles.type]: select(item.type),

      [P.controles.etat]: select(item.etat),

      [P.controles.exigences]: relation(
        linkedPageIds(item.exigences),
      ),
    });
  }

  for (const item of extraction.risques) {
    await createPage(DB.risques, {
      [P.risques.titre]: {
        title: title(item.nom),
      },

      [P.risques.impact]: select(item.impact),

      [P.risques.probabilite]: select(item.probabilite),

      [P.risques.exigence]: relation(
        linkedPageIds([item.exigence]),
      ),
    });
  }

  for (const item of extraction.jurisprudence) {
    await createPage(DB.jurisprudence, {
      [P.jurisprudence.titre]: {
        title: title(item.nom),
      },

      [P.jurisprudence.juridiction]: select(item.juridiction),

      [P.jurisprudence.resume]: {
        rich_text: richText(item.resume),
      },

      [P.jurisprudence.exigences]: relation(
        linkedPageIds(item.exigences),
      ),
    });
  }

  const responsibleId =
    process.env.GRC_DEFAULT_RESPONSABLE_ID?.trim();

  for (const item of extraction.actions) {
    const properties: Record<string, any> = {
      [P.actions.titre]: {
        title: title(item.nom),
      },

      [P.actions.exigences]: relation(
        linkedPageIds(item.exigences),
      ),
    };

    if (responsibleId) {
      properties[P.actions.responsable] = {
        people: [{ id: responsibleId }],
      };
    }

    // Aucune échéance arbitraire n'est créée.
    await createPage(DB.actions, properties);
  }

  console.log("\nAgent GRC terminé avec succès.");
  console.log(
    "Texte source :",
    "url" in sourcePage ? sourcePage.url : sourcePage.id,
  );
  console.log("Exigences :", extraction.exigences.length);
  console.log("Contrôles :", extraction.controles.length);
  console.log("Risques :", extraction.risques.length);
  console.log("Jurisprudence :", extraction.jurisprudence.length);
  console.log("Actions :", extraction.actions.length);
}

main().catch(error => {
  console.error(
    "Erreur de l'agent GRC :",
    error?.body ?? error?.message ?? error,
  );

  process.exitCode = 1;
});