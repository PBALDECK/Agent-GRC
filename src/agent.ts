import "dotenv/config";
import { Client } from "@notionhq/client";
import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import ExcelJS from "exceljs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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
const ORGANISATION_FILE = "./data/organisation.json";
const MATRICES_FILE = ["data", "matrices", "Matrices_GRC.xlsx"];

/** Seuil de ressemblance (0 à 1) au-delà duquel deux exigences sont considérées comme identiques. */
const SEUIL_SIMILARITE = 0.8;

/**
 * Seuil (plus bas) pour les noms de contrôles, risques et actions : on ne l'applique
 * que si l'élément existant est lié à la même exigence, ce qui évite les faux positifs.
 */
const SEUIL_TITRE = 0.4;

const dataSourceIds = new Map<string, string>();

// ==================================================
// 2. SCHÉMAS (Zod)
// ==================================================

// NB : pas de min/max sur les nombres, certains modèles les refusent.
// Les bornes sont appliquées par le code (voir clamp).

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
      citation: z.string().min(1),
      destinataires: z.array(z.string()),
      echeance: z.string().nullable(),
      sanction: z.string().nullable(),
      confiance: z.number(),
      criticite: z.string().min(1),
      statut: z.string().min(1),
      texteOrigine: z.array(z.string()),
    }),
  ),

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
      responsable: z.string().nullable(),
      echeance: z.string().nullable(),
      exigences: z.array(z.string()),
    }),
  ),
});

type Extraction = z.infer<typeof ExtractionSchema>;

/**
 * Second appel de l'IA : impose au moins un contrôle, un risque et une action.
 * Utilisé uniquement si l'extraction principale a renvoyé une de ces listes vide.
 */
const AnalyseSchema = z.object({
  controles: z.array(
    z.object({
      nom: z.string().min(1),
      type: z.string().min(1),
      etat: z.string().min(1),
      exigences: z.array(z.string()).min(1),
    }),
  ).min(1),

  risques: z.array(
    z.object({
      nom: z.string().min(1),
      impact: z.string().min(1),
      probabilite: z.string().min(1),
      exigence: z.string().min(1),
    }),
  ).min(1),

  actions: z.array(
    z.object({
      nom: z.string().min(1),
      responsable: z.string().nullable(),
      echeance: z.string().nullable(),
      exigences: z.array(z.string()).min(1),
    }),
  ).min(1),
});

/** Analyse d'impact, de couverture et de risque résiduel : une entrée par exigence. */
const ImpactSchema = z.object({
  analyses: z.array(
    z.object({
      exigence: z.string().min(1),
      processus: z.array(z.string()),
      systemes: z.array(z.string()),
      donnees: z.array(z.string()),
      contrats: z.array(z.string()),
      controlesExistants: z.array(z.string()),
      couverture: z.enum(["couverte", "partielle", "non couverte", "inconnue"]),
      ecart: z.string(),
      mesuresResiduelles: z.string(),
      graviteResiduelle: z.number(),
      vraisemblanceResiduelle: z.number(),
      confiance: z.number(),
    }),
  ),
});

type AnalyseImpact = z.infer<typeof ImpactSchema>["analyses"][number];

// ==================================================
// 3. PROFIL DE L'ORGANISATION (pour M2, M3, M4)
// ==================================================

type Element = { id: string; nom: string };

type Organisation = {
  nom: string;
  secteur: string;
  description: string;
  processus: Element[];
  systemes: Element[];
  donnees: Element[];
  contrats: Element[];
  controles: (Element & { etat: "oui" | "partiel" | "non" })[];
};

/** Profil FICTIF utilisé tant que tu n'as pas créé data/organisation.json. À adapter. */
const ORGANISATION_PAR_DEFAUT: Organisation = {
  nom: "Atlas Finance (organisation fictive)",
  secteur: "Établissement de paiement en ligne soumis à DORA",
  description:
    "Établissement financier français qui propose des paiements en ligne et s'appuie sur plusieurs prestataires TIC externes (cloud, paiement, supervision).",
  processus: [
    { id: "P1", nom: "Sélection et onboarding des prestataires TIC" },
    { id: "P2", nom: "Traitement des paiements en ligne" },
    { id: "P3", nom: "Gestion des incidents et de la continuité" },
    { id: "P4", nom: "Gestion des contrats fournisseurs" },
  ],
  systemes: [
    { id: "SY1", nom: "Plateforme de paiement hébergée dans le cloud" },
    { id: "SY2", nom: "Application mobile clients" },
    { id: "SY3", nom: "Outil de gestion des contrats (GED)" },
    { id: "SY4", nom: "Supervision de sécurité (SIEM)" },
  ],
  donnees: [
    { id: "D1", nom: "Données d'identité et de comptes clients" },
    { id: "D2", nom: "Données de transactions" },
    { id: "D3", nom: "Registre des prestataires et contrats" },
  ],
  contrats: [
    { id: "C1", nom: "Contrat d'hébergement cloud" },
    { id: "C2", nom: "Contrat de la solution de paiement tierce" },
    { id: "C3", nom: "Contrat de supervision (SOC externalisé)" },
  ],
  controles: [
    { id: "CT-01", nom: "Revue annuelle des fournisseurs critiques", etat: "partiel" },
    { id: "CT-02", nom: "Registre des contrats fournisseurs (tableur)", etat: "partiel" },
    { id: "CT-03", nom: "Clauses de sécurité dans les contrats cloud", etat: "oui" },
    { id: "CT-04", nom: "Clause de résiliation immédiate en cas de faille majeure", etat: "non" },
    { id: "CT-05", nom: "Questionnaire de sécurité avant contractualisation", etat: "partiel" },
  ],
};

async function chargerOrganisation(): Promise<Organisation> {
  let brut: string;

  try {
    brut = await readFile(ORGANISATION_FILE, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;

    await mkdir(resolve("data"), { recursive: true });
    await writeFile(
      resolve(ORGANISATION_FILE),
      JSON.stringify(ORGANISATION_PAR_DEFAUT, null, 2) + "\n",
      "utf-8",
    );

    console.warn(
      `⚠️  ${ORGANISATION_FILE} introuvable : un profil FICTIF a été créé. ` 
    );

    return ORGANISATION_PAR_DEFAUT;
  }

  return JSON.parse(brut) as Organisation;
}

// ==================================================
// 4. PROPRIÉTÉS NOTION
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
 * La comparaison ignore les accents, la casse et les espaces.
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

/** Comme findPropertyName, mais renvoie undefined si la colonne n'existe pas (colonnes facultatives). */
function findOptionalProperty(
  db: any,
  candidates: string[],
  expectedType: string,
): string | undefined {
  try {
    return findPropertyName(db, candidates, expectedType);
  } catch {
    return undefined;
  }
}

/**
 * Détecte automatiquement la propriété titre de la base.
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
// 5. GESTION DES OPTIONS SELECT
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
// 6. HELPERS DE CRÉATION NOTION
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

/** Notion interdit les virgules dans les options Select : on les remplace. */
function cleanSelectName(value: string): string {
  return value
    .replace(/\s*,\s*/g, " – ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

type ArticleDocument = {
  reference: string;
  contenu: string;
};

/**
 * Découpe un document réglementaire en articles.
 *
 * Reconnaît notamment :
 * - Article 1
 * - Article 1er
 * - Article 28 bis
 * - ARTICLE 28 — Titre de l'article
 *
 * Si aucun titre d'article n'est reconnu, le document entier est conservé.
 */
function decouperParArticle(document: string): ArticleDocument[] {
  const lignes = document.replace(/\r\n?/g, "\n").split("\n");

  const motifArticle =
    /^\s*Article\s+((?:premier|1er|\d+[A-Za-z]?(?:\s+(?:bis|ter|quater))?))\b(?:\s*[-–—.:]\s*.*)?\s*$/i;

  const articles: ArticleDocument[] = [];
  let referenceActuelle: string | null = null;
  let lignesActuelles: string[] = [];
  let lignesAvantPremierArticle: string[] = [];

  const enregistrerArticle = () => {
    if (referenceActuelle === null) return;

    const contenu = lignesActuelles.join("\n").trim();

    if (contenu) {
      articles.push({
        reference: referenceActuelle,
        contenu,
      });
    }
  };

  for (const ligne of lignes) {
    const match = ligne.match(motifArticle);

    if (match) {
      enregistrerArticle();

      referenceActuelle = `Article ${match[1].trim()}`;
      lignesActuelles = [];
      continue;
    }

    if (referenceActuelle === null) {
      lignesAvantPremierArticle.push(ligne);
    } else {
      lignesActuelles.push(ligne);
    }
  }

  enregistrerArticle();

  // Si aucun article n'a été détecté, utiliser le document complet.
  if (articles.length === 0) {
    return [{
      reference: "Document complet",
      contenu: document.trim(),
    }];
  }

  // Le préambule n'est pas fusionné artificiellement avec le premier article.
  const preambule = lignesAvantPremierArticle.join("\n").trim();

  if (preambule) {
    console.warn(
      "⚠️ Un préambule précède le premier article détecté. " +
      "Il n'a pas été analysé séparément.",
    );
  }

  return articles;
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
// 7. VALIDATION DES RELATIONS
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
// 8. ANTI-DOUBLONS
// ==================================================

type Existing = {
  id: string;
  title: string;
  article?: string;
  description?: string;
  statut?: string;
  /** Identifiants des pages Notion liées (relation vers les exigences). */
  relations?: string[];
};

/** Compteurs affichés à la fin : combien de pages créées / ignorées par type. */
const stats: Record<string, { crees: number; ignores: number }> = {};

function count(kind: string, created: boolean): void {
  stats[kind] ??= { crees: 0, ignores: 0 };

  if (created) stats[kind].crees++;
  else stats[kind].ignores++;
}

/** Ressemblance entre deux textes (0 à 1), calculée sur les mots communs. */
function similarity(a: string, b: string): number {
  const tokens = (value: string) =>
    new Set(
      value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(word => word.length > 3),
    );

  const A = tokens(a);
  const B = tokens(b);

  if (A.size === 0 || B.size === 0) return 0;

  let common = 0;
  for (const word of A) if (B.has(word)) common++;

  return common / (A.size + B.size - common);
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();

  return items.filter(item => {
    const k = key(item);

    if (!k || seen.has(k)) return false;

    seen.add(k);
    return true;
  });
}

/**
 * Protection n°1 : supprime les doublons produits par l'IA elle-même.
 * Quand une exigence est supprimée, les références des autres éléments
 * sont redirigées vers l'exigence conservée.
 */
function dedupeExtraction(extraction: Extraction): void {
  const alias = new Map<string, string>();
  const kept: Extraction["exigences"] = [];

  for (const item of extraction.exigences) {
    const twin = kept.find(
      other =>
        other.id === item.id ||
        (normalizeName(other.article) === normalizeName(item.article) &&
          similarity(other.description, item.description) >= SEUIL_SIMILARITE),
    );

    if (twin) {
      alias.set(item.id, twin.id);
      console.warn(`Doublon ignoré : ${item.id} (identique à ${twin.id})`);
    } else {
      kept.push(item);
    }
  }

  extraction.exigences = kept;

  const fix = (id: string) => alias.get(id) ?? id;
  const fixAll = (ids: string[]) => [...new Set(ids.map(fix))];

  for (const item of extraction.controles) item.exigences = fixAll(item.exigences);
  for (const item of extraction.jurisprudence) item.exigences = fixAll(item.exigences);
  for (const item of extraction.actions) item.exigences = fixAll(item.exigences);
  for (const item of extraction.risques) item.exigence = fix(item.exigence);

  extraction.controles = dedupeBy(extraction.controles, c => normalizeName(c.nom));
  extraction.risques = dedupeBy(extraction.risques, r => normalizeName(r.nom));
  extraction.jurisprudence = dedupeBy(extraction.jurisprudence, j => normalizeName(j.nom));
  extraction.actions = dedupeBy(extraction.actions, a => normalizeName(a.nom));
}

function plainText(property: any): string {
  const parts = property?.title ?? property?.rich_text ?? [];
  return parts.map((part: any) => part.plain_text ?? "").join("");
}

/** Lit toutes les pages déjà présentes dans une base Notion (avec pagination). */
async function loadExisting(
  databaseId: string,
  titleProp: string,
  extra?: {
    article?: string;
    description?: string;
    statut?: string;
    relation?: string;
  },
): Promise<Existing[]> {
  const dataSourceId = dataSourceIds.get(databaseId);

  if (!dataSourceId) {
    throw new Error(
      `Source de données non initialisée pour la base ${databaseId}.`,
    );
  }

  const result: Existing[] = [];
  let cursor: string | undefined;

  do {
    const response: any = await notion.dataSources.query({
      data_source_id: dataSourceId,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const page of response.results) {
      const props = page.properties ?? {};

      result.push({
        id: page.id,
        title: plainText(props[titleProp]),
        article: extra?.article
          ? props[extra.article]?.select?.name ?? ""
          : undefined,
        description: extra?.description
          ? plainText(props[extra.description])
          : undefined,
        statut: extra?.statut
          ? props[extra.statut]?.select?.name ?? undefined
          : undefined,
        relations: extra?.relation
          ? (props[extra.relation]?.relation ?? []).map(
              (liee: { id: string }) => liee.id,
            )
          : undefined,
      });
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return result;
}

/**
 * Protection n°2 : crée la page seulement si aucune page du même titre n'existe.
 * Renvoie l'identifiant de la page (existante ou nouvelle) pour les relations.
 */
async function createOnce(
  kind: string,
  databaseId: string,
  existing: Existing[],
  name: string,
  properties: Record<string, any>,
  linkedIds: string[] = [],
): Promise<string> {
  const found = existing.find(
    e =>
      // même titre...
      normalizeName(e.title) === normalizeName(name) ||
      // ... ou titre proche ET lié à au moins une exigence en commun
      (linkedIds.length > 0 &&
        (e.relations ?? []).some(id => linkedIds.includes(id)) &&
        similarity(e.title, name) >= SEUIL_TITRE),
  );

  if (found) {
    if (normalizeName(found.title) !== normalizeName(name)) {
      console.log(`  « ${name} » ignoré : proche de « ${found.title} » (${kind} déjà présent)`);
    }

    count(kind, false);
    return found.id;
  }

  const page = await createPage(databaseId, properties);

  existing.push({ id: page.id, title: name, relations: linkedIds });
  count(kind, true);

  return page.id;
}

/**
 * Une exigence existe déjà si son ID est identique,
 * ou si l'article est le même et la description très proche.
 */
function findExistingExigence(
  existing: Existing[],
  item: Extraction["exigences"][number],
): Existing | undefined {
  const article = normalizeName(item.article.trim().slice(0, 100));

  return existing.find(
    e =>
      normalizeName(e.title) === normalizeName(item.id) ||
      (e.article &&
        e.description &&
        normalizeName(e.article) === article &&
        similarity(e.description, item.description) >= SEUIL_SIMILARITE),
  );
}

// ==================================================
// 9. VÉRIFICATION DES CITATIONS ET ANALYSE D'IMPACT
// ==================================================

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : min)));

const clamp01 = (value: number) =>
  Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

/**
 * Garde-fou : la citation donnée par l'IA doit exister mot pour mot dans le texte source
 * (la comparaison ignore la casse, les accents, la ponctuation et les espaces).
 */
function citationPresente(citation: string, document: string): boolean {
  const c = normalizeName(citation);

  if (c.length < 15) return false;

  return normalizeName(document).includes(c);
}

type Verification = { citationVerifiee: boolean; confiance: number };

function verifierCitations(
  extraction: Extraction,
  document: string,
): Map<string, Verification> {
  const result = new Map<string, Verification>();

  for (const item of extraction.exigences) {
    const verifiee = citationPresente(item.citation, document);
    const confiance = clamp01(item.confiance);

    result.set(item.id, {
      citationVerifiee: verifiee,
      // Citation introuvable : la confiance est plafonnée à 30 %.
      confiance: verifiee ? confiance : Math.min(confiance, 0.3),
    });

    if (!verifiee) {
      console.warn(
        `⚠️  Citation introuvable dans le texte pour ${item.id} : à vérifier à la main.`,
      );
    }
  }

  return result;
}

async function analyserImpact(
  extraction: Extraction,
  organisation: Organisation,
): Promise<Map<string, AnalyseImpact>> {
  const exigences = extraction.exigences.map(item => ({
    id: item.id,
    article: item.article,
    description: item.description,
    sanction: item.sanction,
    criticite: item.criticite,
  }));

  const { object } = await generateObject({
    model: openai("gpt-4o-mini"),
    schema: ImpactSchema,
    temperature: 0,
    prompt: `
Tu es un analyste GRC. Pour CHAQUE exigence ci-dessous, évalue son impact sur
l'organisation, la couverture par ses contrôles existants et le risque résiduel.

RÈGLES IMPÉRATIVES :
- Renvoie exactement UNE entrée par exigence (champ "exigence" = l'ID exact).
- Utilise UNIQUEMENT les identifiants du profil (processus P*, systèmes SY*,
  données D*, contrats C*, contrôles CT-*). N'invente aucun identifiant.
- controlesExistants : les contrôles du profil qui contribuent réellement à
  respecter l'exigence (liste vide si aucun).
- couverture : "couverte" (contrôle(s) en état "oui" suffisant(s)), "partielle",
  "non couverte" (aucun contrôle pertinent), "inconnue" (le profil ne permet
  pas de conclure). Ne conclus pas "couverte" sans contrôle en état "oui".
- ecart : ce qui manque pour respecter l'exigence (phrase courte).
- mesuresResiduelles : mesures complémentaires proposées pour réduire le risque.
- graviteResiduelle et vraisemblanceResiduelle : entiers de 1 (faible) à 4 (critique),
  après prise en compte des contrôles existants.
- confiance : nombre entre 0 et 1. Baisse-la si le profil est insuffisant.
- Ce sont des hypothèses d'analyse à faire valider par un humain.

PROFIL DE L'ORGANISATION :
${JSON.stringify(organisation, null, 2)}

EXIGENCES :
${JSON.stringify(exigences, null, 2)}
`,
  });

  const idsValides = (liste: Element[]) => new Set(liste.map(e => e.id));
  const processus = idsValides(organisation.processus);
  const systemes = idsValides(organisation.systemes);
  const donnees = idsValides(organisation.donnees);
  const contrats = idsValides(organisation.contrats);
  const controles = idsValides(organisation.controles);

  const garder = (ids: string[], valides: Set<string>) =>
    [...new Set(ids.filter(id => valides.has(id)))];

  const result = new Map<string, AnalyseImpact>();

  for (const analyse of object.analyses) {
    result.set(analyse.exigence, {
      ...analyse,
      processus: garder(analyse.processus, processus),
      systemes: garder(analyse.systemes, systemes),
      donnees: garder(analyse.donnees, donnees),
      contrats: garder(analyse.contrats, contrats),
      controlesExistants: garder(analyse.controlesExistants, controles),
      graviteResiduelle: clamp(analyse.graviteResiduelle, 1, 4),
      vraisemblanceResiduelle: clamp(analyse.vraisemblanceResiduelle, 1, 4),
      confiance: clamp01(analyse.confiance),
    });
  }

  // Une exigence oubliée par l'IA reçoit une entrée "inconnue" plutôt que d'être absente.
  for (const item of extraction.exigences) {
    if (!result.has(item.id)) {
      console.warn(`⚠️  Pas d'analyse d'impact pour ${item.id} : valeurs par défaut.`);

      result.set(item.id, {
        exigence: item.id,
        processus: [],
        systemes: [],
        donnees: [],
        contrats: [],
        controlesExistants: [],
        couverture: "inconnue",
        ecart: "Analyse non produite par l'IA : à compléter manuellement.",
        mesuresResiduelles: "",
        graviteResiduelle: 1,
        vraisemblanceResiduelle: 1,
        confiance: 0,
      });
    }
  }

  return result;
}

// ==================================================
// 10. MATRICES GRC (M1 à M5) — EXPORT EXCEL
// ==================================================

type Colonne = { header: string; key: string; width: number };

function ajouterFeuille(
  workbook: ExcelJS.Workbook,
  nom: string,
  colonnes: Colonne[],
  lignes: Record<string, any>[],
): ExcelJS.Worksheet {
  const feuille = workbook.addWorksheet(nom, {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  feuille.columns = colonnes.map(c => ({
    header: c.header,
    key: c.key,
    width: c.width,
  }));

  const entete = feuille.getRow(1);
  entete.font = { bold: true, color: { argb: "FFFFFFFF" } };
  entete.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F3864" },
  };
  entete.alignment = { vertical: "middle", wrapText: true };

  for (const ligne of lignes) feuille.addRow(ligne);

  feuille.eachRow((row, numero) => {
    if (numero > 1) row.alignment = { vertical: "top", wrapText: true };
  });

  feuille.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: colonnes.length },
  };

  return feuille;
}

type ContexteMatrices = {
  extraction: Extraction;
  organisation: Organisation;
  analyses: Map<string, AnalyseImpact>;
  verifications: Map<string, Verification>;
  statuts: Map<string, string>;
};

async function exporterMatrices(ctx: ContexteMatrices): Promise<string> {
  const { extraction, organisation, analyses, verifications, statuts } = ctx;

  const libelle = (liste: Element[], ids: string[]) =>
    ids.length === 0
      ? "—"
      : ids
          .map(id => {
            const element = liste.find(e => e.id === id);
            return element ? `${id} – ${element.nom}` : id;
          })
          .join("\n");

  const analyseDe = (id: string) => analyses.get(id)!;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Agent GRC";
  workbook.created = new Date();

  // ---------- Lisez-moi ----------
  const lisezMoi = workbook.addWorksheet("Lisez-moi");
  lisezMoi.columns = [{ width: 28 }, { width: 100 }];
  lisezMoi.addRows([
    ["Matrices GRC", ""],
    ["Organisation", `${organisation.nom} — ${organisation.secteur}`],
    ["Texte analysé", extraction.texte.nom],
    ["Source", extraction.texte.source],
    ["URL officielle", extraction.texte.url ?? "non renseignée"],
    ["Généré le", new Date().toLocaleString("fr-FR")],
    ["Identifiants", "Toutes les matrices partagent les mêmes identifiants d'exigences (EX-…) pour la traçabilité."],
    [
      "Avertissement",
      "Exigences, citations et références proviennent du texte. Les analyses d'impact, de couverture et de risque " +
      "sont des HYPOTHÈSES de l'IA fondées sur le profil de l'organisation : à valider par un humain.",
    ],
  ]);
  lisezMoi.getRow(1).font = { bold: true, size: 14 };
  lisezMoi.getColumn(1).font = { bold: true };

  // ---------- M1 Traçabilité ----------
  ajouterFeuille(
    workbook,
    "M1 Traçabilité",
    [
      { header: "ID exigence", key: "id", width: 18 },
      { header: "Texte", key: "texte", width: 30 },
      { header: "Article", key: "article", width: 18 },
      { header: "Exigence", key: "description", width: 55 },
      { header: "Citation officielle", key: "citation", width: 55 },
      { header: "Citation vérifiée", key: "verifiee", width: 14 },
      { header: "Destinataires", key: "destinataires", width: 24 },
      { header: "Échéance", key: "echeance", width: 26 },
      { header: "Sanction", key: "sanction", width: 26 },
      { header: "Criticité", key: "criticite", width: 12 },
      { header: "Confiance", key: "confiance", width: 11 },
      { header: "Statut de validation", key: "statut", width: 20 },
    ],
    extraction.exigences.map(item => {
      const verification = verifications.get(item.id)!;

      return {
        id: item.id,
        texte: extraction.texte.nom,
        article: item.article,
        description: item.description,
        citation: item.citation,
        verifiee: verification.citationVerifiee ? "Oui" : "NON — à vérifier",
        destinataires: item.destinataires.join(", ") || "—",
        echeance: item.echeance ?? "Aucune échéance précisée dans le texte",
        sanction: item.sanction ?? "Aucune sanction précisée dans le texte",
        criticite: item.criticite,
        confiance: verification.confiance,
        statut: statuts.get(item.id) ?? "à valider",
      };
    }),
  ).getColumn("confiance").numFmt = "0%";

  // ---------- M2 Impact ----------
  ajouterFeuille(
    workbook,
    "M2 Impact",
    [
      { header: "ID exigence", key: "id", width: 18 },
      { header: "Exigence", key: "description", width: 50 },
      { header: "Processus", key: "processus", width: 38 },
      { header: "Systèmes", key: "systemes", width: 38 },
      { header: "Données", key: "donnees", width: 34 },
      { header: "Contrats", key: "contrats", width: 38 },
      { header: "Confiance", key: "confiance", width: 11 },
    ],
    extraction.exigences.map(item => {
      const analyse = analyseDe(item.id);

      return {
        id: item.id,
        description: item.description,
        processus: libelle(organisation.processus, analyse.processus),
        systemes: libelle(organisation.systemes, analyse.systemes),
        donnees: libelle(organisation.donnees, analyse.donnees),
        contrats: libelle(organisation.contrats, analyse.contrats),
        confiance: analyse.confiance,
      };
    }),
  ).getColumn("confiance").numFmt = "0%";

  // ---------- M3 Couverture ----------
  ajouterFeuille(
    workbook,
    "M3 Couverture",
    [
      { header: "ID exigence", key: "id", width: 18 },
      { header: "Exigence", key: "description", width: 50 },
      { header: "Contrôles existants", key: "controles", width: 48 },
      { header: "État des contrôles", key: "etats", width: 24 },
      { header: "Couverture", key: "couverture", width: 16 },
      { header: "Écart", key: "ecart", width: 50 },
    ],
    extraction.exigences.map(item => {
      const analyse = analyseDe(item.id);

      const controles = analyse.controlesExistants.map(id =>
        organisation.controles.find(c => c.id === id),
      ).filter((c): c is NonNullable<typeof c> => Boolean(c));

      return {
        id: item.id,
        description: item.description,
        controles: controles.length
          ? controles.map(c => `${c.id} – ${c.nom}`).join("\n")
          : "Aucun",
        etats: controles.length
          ? controles.map(c => `${c.id} : ${c.etat}`).join("\n")
          : "—",
        couverture: analyse.couverture,
        ecart: analyse.ecart,
      };
    }),
  );

  // ---------- M4 Risque ----------
  const colonnesM4: Colonne[] = [
    { header: "ID risque", key: "idRisque", width: 12 },
    { header: "ID exigence", key: "id", width: 18 },
    { header: "Risque", key: "risque", width: 48 },
    { header: "Impact (brut)", key: "impact", width: 16 },
    { header: "Probabilité (brute)", key: "probabilite", width: 18 },
    { header: "Mesures proposées", key: "mesures", width: 50 },
    { header: "Gravité résiduelle (1-4)", key: "gravite", width: 16 },
    { header: "Vraisemblance résiduelle (1-4)", key: "vraisemblance", width: 18 },
    { header: "Niveau résiduel (G × V)", key: "niveau", width: 16 },
    { header: "Confiance", key: "confiance", width: 11 },
  ];

  const feuilleM4 = ajouterFeuille(workbook, "M4 Risque", colonnesM4, []);
  const lettreGravite = feuilleM4.getColumn("gravite").letter;
  const lettreVraisemblance = feuilleM4.getColumn("vraisemblance").letter;

  extraction.risques.forEach((risque, index) => {
    const analyse = analyseDe(risque.exigence);

    const ligne = feuilleM4.addRow({
      idRisque: `RK-${String(index + 1).padStart(3, "0")}`,
      id: risque.exigence,
      risque: risque.nom,
      impact: risque.impact,
      probabilite: risque.probabilite,
      mesures: analyse?.mesuresResiduelles || "—",
      gravite: analyse?.graviteResiduelle ?? 1,
      vraisemblance: analyse?.vraisemblanceResiduelle ?? 1,
      confiance: analyse?.confiance ?? 0,
    });

    const numero = ligne.number;

    ligne.getCell("niveau").value = {
      formula: `${lettreGravite}${numero}*${lettreVraisemblance}${numero}`,
      result: (analyse?.graviteResiduelle ?? 1) * (analyse?.vraisemblanceResiduelle ?? 1),
    };

    ligne.alignment = { vertical: "top", wrapText: true };
  });

  feuilleM4.getColumn("confiance").numFmt = "0%";

  // ---------- M5 Jurisprudence ----------
  const lignesM5: Record<string, any>[] = [];

  extraction.exigences.forEach(item => {
    const decisions = extraction.jurisprudence
      .map((decision, index) => ({ decision, index }))
      .filter(({ decision }) => decision.exigences.includes(item.id));

    if (decisions.length === 0) {
      lignesM5.push({
        id: item.id,
        description: item.description,
        idDecision: "—",
        decision: "Aucune décision retenue",
        juridiction: "—",
        apport: "Aucune décision identifiable dans le texte analysé.",
      });
      return;
    }

    for (const { decision, index } of decisions) {
      lignesM5.push({
        id: item.id,
        description: item.description,
        idDecision: `JP-${String(index + 1).padStart(2, "0")}`,
        decision: decision.nom,
        juridiction: decision.juridiction,
        apport: decision.resume,
      });
    }
  });

  ajouterFeuille(
    workbook,
    "M5 Jurisprudence",
    [
      { header: "ID exigence", key: "id", width: 18 },
      { header: "Exigence", key: "description", width: 50 },
      { header: "ID décision", key: "idDecision", width: 12 },
      { header: "Décision", key: "decision", width: 40 },
      { header: "Juridiction", key: "juridiction", width: 22 },
      { header: "Apport de la décision", key: "apport", width: 60 },
    ],
    lignesM5,
  );

  const chemin = resolve(...MATRICES_FILE);
  await mkdir(resolve(MATRICES_FILE[0], MATRICES_FILE[1]), { recursive: true });
  await workbook.xlsx.writeFile(chemin);

  return chemin;
}

// ==================================================
// 11. AGENT PRINCIPAL
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

      // Colonnes FACULTATIVES : renseignées seulement si elles existent dans Notion.
      citation: findOptionalProperty(exigencesDb, ["Citation"], "rich_text"),
      echeance: findOptionalProperty(exigencesDb, ["Échéance", "Echeance"], "rich_text"),
      sanction: findOptionalProperty(exigencesDb, ["Sanction"], "rich_text"),
      citationVerifiee: findOptionalProperty(
        exigencesDb,
        ["Citation vérifiée", "Citation verifiee"],
        "checkbox",
      ),
      confiance: findOptionalProperty(exigencesDb, ["Confiance"], "number"),
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

  const colonnesFacultativesAbsentes = Object.entries({
    Citation: P.exigences.citation,
    Échéance: P.exigences.echeance,
    Sanction: P.exigences.sanction,
    "Citation vérifiée": P.exigences.citationVerifiee,
    Confiance: P.exigences.confiance,
  })
    .filter(([, nom]) => !nom)
    .map(([libelle]) => libelle);

  if (colonnesFacultativesAbsentes.length > 0) {
    console.warn(
      "ℹ️  Colonnes absentes dans la base Exigences (non enregistrées dans Notion, " +
      `mais présentes dans les matrices Excel) : ${colonnesFacultativesAbsentes.join(", ")}`,
    );
  }

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

  console.log("2/6 — Lecture du document et du profil de l'organisation");

  const document = (await readFile(SOURCE_FILE, "utf8")).trim();

  if (!document) {
    throw new Error(`Le fichier ${SOURCE_FILE} est vide.`);
  }

  const organisation = await chargerOrganisation();

console.log("3/6 — Extraction des données GRC par article");

  const articles = decouperParArticle(document);

  console.log(`${articles.length} section(s) à analyser :`);
  for (const article of articles) {
    console.log(`  - ${article.reference}`);
  }

  const extractionsPartielles: Extraction[] = [];

  // Les métadonnées sont recherchées dans le début du document complet.
  // Chaque appel IA reçoit en revanche le contenu d'un seul article.
  const metadonneesDocument = document.slice(0, 4000);

  for (let index = 0; index < articles.length; index++) {
    const article = articles[index];

    console.log(
      `Analyse ${index + 1}/${articles.length} : ${article.reference}`,
    );

    const { object } = await generateObject({
      model: openai("gpt-4o-mini"),
      schema: ExtractionSchema,
      temperature: 0,
      prompt: `
Tu es un assistant GRC spécialisé en conformité réglementaire.

Tu analyses UN SEUL ARTICLE d'un texte réglementaire. N'utilise pas
tes connaissances externes pour compléter le contenu fourni.

ARTICLE À ANALYSER : ${article.reference}

MÉTADONNÉES DU DOCUMENT COMPLET :
Le début du document est fourni ci-dessous uniquement pour identifier
la source, son nom, son URL éventuelle et les informations générales.
Ne tire aucune exigence de ce passage si elle n'apparaît pas dans
le contenu de l'article à analyser.

---
${metadonneesDocument}
---

CONTENU DE L'ARTICLE À ANALYSER :
---
${article.contenu}
---

RÈGLES IMPÉRATIVES :

1. EXTRACTION
- Extrais uniquement les exigences présentes dans le contenu de l'article
  indiqué ci-dessus.
- N'extrais aucune exigence provenant d'un autre article.
- Si cet article ne contient aucune obligation exploitable, renvoie
  une liste "exigences" vide.
- Ne reformule jamais la même obligation deux fois.
- Chaque exigence doit contenir une citation copiée mot pour mot du
  contenu de l'article.
- N'invente ni texte de loi, ni citation, ni sanction, ni décision de justice.

2. IDENTIFIANTS ET TRAÇABILITÉ
- Chaque ID doit être unique dans cet article et respecter le format
  EX-DORA-<NUMERO-ARTICLE>-<NNN>, par exemple EX-DORA-28-001.
- Le numéro final commence à 001 pour chaque article.
- Le champ "article" doit indiquer l'article analysé et, si possible,
  le paragraphe précis, par exemple "Article 28 §1".
- Utilise exclusivement ces identifiants dans les relations entre
  exigences, contrôles, risques et actions.
- Le champ "texteOrigine" doit rester cohérent avec le nom du texte.

3. CITATIONS ET INFORMATIONS
- "citation" : extrait exact du contenu de l'article, sans reformulation.
- "echeance" : délai explicitement indiqué, sinon null.
- "sanction" : sanction explicitement indiquée, sinon null.
- "destinataires" : personnes ou entités visées par l'obligation.
- "confiance" : nombre entre 0 et 1.
- "dateEntreeEnVigueur" : date explicite au format YYYY-MM-DD, sinon null.
- "url" : URL présente dans les métadonnées, sinon null.
- "texte.nom" doit reprendre exactement le nom du texte réglementaire.
- "texte.source" doit correspondre à une option autorisée ci-dessous.

4. CONTRÔLES, RISQUES ET ACTIONS
- Pour chaque exigence, propose au moins un contrôle pertinent,
  un risque de non-conformité et une action corrective.
- Ces éléments sont des propositions d'analyse, pas des citations du texte.
- Un contrôle, un risque ou une action peut couvrir plusieurs exigences
  de CET article si cela est justifié.
- N'invente ni responsable ni échéance d'action : utilise null si inconnu.
- Si aucune exigence n'est extraite, renvoie des listes vides pour
  contrôles, risques, jurisprudence et actions.
- N'ajoute une jurisprudence que si une décision identifiable est
  explicitement mentionnée dans le contenu de l'article.

5. OPTIONS AUTORISÉES
Choisis exclusivement parmi les valeurs suivantes pour les champs Select :

Source : ${options.source.join(" | ")}
Criticité : ${options.criticite.join(" | ")}
Statut : ${statutInitial}
Type de contrôle : ${options.typeControle.join(" | ")}
État du contrôle : ${options.etatControle.join(" | ")}
Impact : ${options.impact.join(" | ")}
Probabilité : ${options.probabilite.join(" | ")}
Juridiction : ${options.juridiction.join(" | ")}

Pour "Article", utilise la référence précise de l'article analysé,
sans virgule. Les options manquantes pourront être ajoutées ensuite.

Produis uniquement les données correspondant à l'article analysé.
`,
    });

    // Évite de traiter les tableaux retournés par l'IA comme des références
    // partagées : chaque résultat est conservé séparément avant fusion.
    extractionsPartielles.push(object as Extraction);

    console.log(
      `  ${object.exigences.length} exigence(s), ` +
      `${object.controles.length} contrôle(s), ` +
      `${object.risques.length} risque(s), ` +
      `${object.actions.length} action(s)`,
    );
  }

  if (extractionsPartielles.length === 0) {
    throw new Error("Aucune extraction n'a été produite.");
  }

  // Fusion des résultats article par article.
  const extraction: Extraction = {
    texte: extractionsPartielles[0].texte,

    exigences: extractionsPartielles.flatMap(
      resultat => resultat.exigences,
    ),

    controles: extractionsPartielles.flatMap(
      resultat => resultat.controles,
    ),

    risques: extractionsPartielles.flatMap(
      resultat => resultat.risques,
    ),

    jurisprudence: extractionsPartielles.flatMap(
      resultat => resultat.jurisprudence,
    ),

    actions: extractionsPartielles.flatMap(
      resultat => resultat.actions,
    ),
  };

  // Vérification minimale avant les traitements suivants.
  if (extraction.exigences.length === 0) {
    throw new Error(
      "Aucune exigence n'a été extraite des articles. " +
      "Vérifie le format du document et les titres d'articles.",
    );
  }

  // Les identifiants générés indépendamment par chaque appel peuvent
  // se répéter. On les rend uniques avant de réparer les relations.
  const idsUtilises = new Set<string>();

  for (const item of extraction.exigences) {
    const idOriginal = item.id;

    if (!idsUtilises.has(item.id)) {
      idsUtilises.add(item.id);
      continue;
    }

    let numero = 2;
    let nouvelId = `${idOriginal}-${numero}`;

    while (idsUtilises.has(nouvelId)) {
      numero++;
      nouvelId = `${idOriginal}-${numero}`;
    }

    console.warn(
      `ID d'exigence répété "${idOriginal}" : renommé en "${nouvelId}".`,
    );

    item.id = nouvelId;
    idsUtilises.add(nouvelId);

    // Les relations générées dans le même article doivent être réparées
    // si elles pointaient vers l'ancien ID du doublon.
    // En cas d'ambiguïté, une validation humaine reste nécessaire.
  }

  // Les références inter-listes sont contrôlées après la fusion.
  // Le bloc dedupeExtraction(extraction) existant reste ensuite exécuté.

  // Les articles deviennent des options Select : pas de virgule autorisée par Notion.
  for (const item of extraction.exigences) {
    item.article = cleanSelectName(item.article);
  }

  // Si l'IA a laissé des listes vides, on la relance avec un schéma qui impose
  // au moins un contrôle, un risque et une action pour les exigences extraites.
  if (
    extraction.controles.length === 0 ||
    extraction.risques.length === 0 ||
    extraction.actions.length === 0
  ) {
    console.log(
      "3 bis — Analyse complémentaire (contrôles, risques, actions)",
    );

    const exigencesPourAnalyse = extraction.exigences.map(item => ({
      id: item.id,
      article: item.article,
      description: item.description,
      criticite: item.criticite,
    }));

    const { object: analyse } = await generateObject({
      model: openai("gpt-4o-mini"),
      schema: AnalyseSchema,
      temperature: 0,
      prompt: `
Tu es un assistant GRC spécialisé en conformité réglementaire.

À partir des exigences ci-dessous (extraites du texte ${extraction.texte.nom}),
propose l'analyse de conformité suivante :

- CONTRÔLES : au moins un contrôle (organisationnel ou technique) qui permettrait
  de respecter chaque exigence. Un contrôle peut couvrir plusieurs exigences.
- RISQUES : au moins un risque de non-conformité par exigence critique ou importante.
  Le champ "exigence" contient l'ID exact d'UNE seule exigence.
- ACTIONS : au moins une action corrective ou de mise en conformité, avec les ID
  exacts des exigences qu'elle traite.

RÈGLES IMPÉRATIVES :
- Ce sont des propositions d'analyse, pas des citations du texte.
- Utilise uniquement les ID d'exigence fournis, exactement tels quels.
- Ne fabrique ni responsable ni échéance (renvoie null).
- Ne propose aucun doublon : chaque contrôle, risque et action est unique.
- Choisis exclusivement parmi les options suivantes pour les Select :

Type de contrôle : ${options.typeControle.join(" | ")}
État du contrôle : ${options.etatControle.join(" | ")}
Impact : ${options.impact.join(" | ")}
Probabilité : ${options.probabilite.join(" | ")}

EXIGENCES :
${JSON.stringify(exigencesPourAnalyse, null, 2)}
`,
    });

    if (extraction.controles.length === 0) extraction.controles = analyse.controles;
    if (extraction.risques.length === 0) extraction.risques = analyse.risques;
    if (extraction.actions.length === 0) extraction.actions = analyse.actions;
  }

  // Les doublons de l'IA sont retirés AVANT la validation des références.
  dedupeExtraction(extraction);
  validateReferences(extraction);

  console.log("3 ter — Vérification des citations et analyse d'impact");

  const verifications = verifierCitations(extraction, document);
  const analyses = await analyserImpact(extraction, organisation);

  console.log("4/6 — Vérification des options et création de la source");

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

  // ---------- Texte source ----------

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

  const textesExistants = await loadExisting(DB.textes, P.textes.titre);

  const sourcePageId = await createOnce(
    "texte",
    DB.textes,
    textesExistants,
    extraction.texte.nom,
    sourceProperties,
  );

  console.log("5/6 — Création des exigences");

  const requirementPageIds = new Map<string, string>();
  const statuts = new Map<string, string>();

  const exigencesExistantes = await loadExisting(
    DB.exigences,
    P.exigences.titre,
    {
      article: P.exigences.article,
      description: P.exigences.description,
      statut: P.exigences.statut,
    },
  );

  for (const item of extraction.exigences) {
    const found = findExistingExigence(exigencesExistantes, item);

    if (found) {
      // On réutilise la page existante pour les relations.
      // Son statut de validation (décision humaine) n'est JAMAIS écrasé.
      requirementPageIds.set(item.id, found.id);
      statuts.set(item.id, found.statut ?? statutInitial);
      count("exigence", false);
      continue;
    }

    const article = item.article.trim().slice(0, 100);
    const verification = verifications.get(item.id)!;

    const properties: Record<string, any> = {
      [P.exigences.titre]: {
        title: title(item.id),
      },

      [P.exigences.article]: select(article),

      [P.exigences.description]: {
        rich_text: richText(item.description),
      },

      [P.exigences.criticite]: select(item.criticite),

      [P.exigences.statut]: select(statutInitial),

      [P.exigences.texteOrigine]: relation([sourcePageId]),
    };

    // Colonnes facultatives
    if (P.exigences.citation) {
      properties[P.exigences.citation] = { rich_text: richText(item.citation) };
    }

    if (P.exigences.echeance && item.echeance) {
      properties[P.exigences.echeance] = { rich_text: richText(item.echeance) };
    }

    if (P.exigences.sanction && item.sanction) {
      properties[P.exigences.sanction] = { rich_text: richText(item.sanction) };
    }

    if (P.exigences.citationVerifiee) {
      properties[P.exigences.citationVerifiee] = {
        checkbox: verification.citationVerifiee,
      };
    }

    if (P.exigences.confiance) {
      properties[P.exigences.confiance] = { number: verification.confiance };
    }

    const page = await createPage(DB.exigences, properties);

    exigencesExistantes.push({
      id: page.id,
      title: item.id,
      article,
      description: item.description,
      statut: statutInitial,
    });

    requirementPageIds.set(item.id, page.id);
    statuts.set(item.id, statutInitial);
    count("exigence", true);
  }

  const linkedPageIds = (ids: string[]) =>
    ids
      .map(id => requirementPageIds.get(id))
      .filter((id): id is string => Boolean(id));

  console.log(
    "6/6 — Création des contrôles, risques, jurisprudences et actions",
  );

  const controlesExistants = await loadExisting(
    DB.controles,
    P.controles.titre,
    { relation: P.controles.exigences },
  );

  for (const item of extraction.controles) {
    const liees = linkedPageIds(item.exigences);

    await createOnce(
      "contrôle",
      DB.controles,
      controlesExistants,
      item.nom,
      {
        [P.controles.titre]: {
          title: title(item.nom),
        },

        [P.controles.type]: select(item.type),

        [P.controles.etat]: select(item.etat),

        [P.controles.exigences]: relation(liees),
      },
      liees,
    );
  }

  const risquesExistants = await loadExisting(DB.risques, P.risques.titre, {
    relation: P.risques.exigence,
  });

  for (const item of extraction.risques) {
    const liees = linkedPageIds([item.exigence]);

    await createOnce(
      "risque",
      DB.risques,
      risquesExistants,
      item.nom,
      {
        [P.risques.titre]: {
          title: title(item.nom),
        },

        [P.risques.impact]: select(item.impact),

        [P.risques.probabilite]: select(item.probabilite),

        [P.risques.exigence]: relation(liees),
      },
      liees,
    );
  }

  const jurisprudenceExistante = await loadExisting(
    DB.jurisprudence,
    P.jurisprudence.titre,
    { relation: P.jurisprudence.exigences },
  );

  for (const item of extraction.jurisprudence) {
    const liees = linkedPageIds(item.exigences);

    await createOnce(
      "jurisprudence",
      DB.jurisprudence,
      jurisprudenceExistante,
      item.nom,
      {
        [P.jurisprudence.titre]: {
          title: title(item.nom),
        },

        [P.jurisprudence.juridiction]: select(item.juridiction),

        [P.jurisprudence.resume]: {
          rich_text: richText(item.resume),
        },

        [P.jurisprudence.exigences]: relation(liees),
      },
      liees,
    );
  }

  const responsibleId =
    process.env.GRC_DEFAULT_RESPONSABLE_ID?.trim();

  const actionsExistantes = await loadExisting(DB.actions, P.actions.titre, {
    relation: P.actions.exigences,
  });

  for (const item of extraction.actions) {
    const liees = linkedPageIds(item.exigences);

    const properties: Record<string, any> = {
      [P.actions.titre]: {
        title: title(item.nom),
      },

      [P.actions.exigences]: relation(liees),
    };

    if (responsibleId) {
      properties[P.actions.responsable] = {
        people: [{ id: responsibleId }],
      };
    }

    await createOnce(
      "action",
      DB.actions,
      actionsExistantes,
      item.nom,
      properties,
      liees,
    );
  }

  console.log("Génération des matrices GRC (M1 à M5)");

  const cheminMatrices = await exporterMatrices({
    extraction,
    organisation,
    analyses,
    verifications,
    statuts,
  });

  console.log(`Matrices créées : ${cheminMatrices}`);

  await exportExigencesJson({
    ...extraction,
    exigences: extraction.exigences.map(item => ({
      ...item,
      citationVerifiee: verifications.get(item.id)?.citationVerifiee ?? false,
      confiance: verifications.get(item.id)?.confiance ?? 0,
      statutValidation: statuts.get(item.id) ?? statutInitial,
      analyse: analyses.get(item.id) ?? null,
    })),
  });

  console.log("Agent GRC terminé avec succès");
  console.log("Texte source (page Notion) :", sourcePageId);
  console.table(stats);
}

async function exportExigencesJson(data: unknown): Promise<void> {
  const outputDir = resolve("data");

  await mkdir(outputDir, { recursive: true });

  const outputPath = resolve(outputDir, "exigences.json");

  await writeFile(
    outputPath,
    JSON.stringify(data, null, 2) + "\n",
    "utf-8",
  );

  console.log(`Export JSON créé : ${outputPath}`);
}

main().catch(error => {
  console.error(
    "Erreur de l'agent GRC :",
    error?.body ?? error?.message ?? error,
  );

  process.exitCode = 1;
});