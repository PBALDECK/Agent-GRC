import "dotenv/config";
import { Client } from "@notionhq/client";
import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
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

/**
 * À incrémenter quand tu modifies un PROMPT ou un SCHÉMA Zod : cela invalide le cache
 * des réponses de l'IA (data/cache). Le reste du code (IDs, paragraphes, matrices...)
 * est recalculé à chaque lancement et n'a pas besoin de cette version.
 */
const VERSION_PROMPT = "v1";

const CACHE_DIR = resolve("data", "cache");

/** Taille maximale (en caractères) d'un passage envoyé à l'IA en un seul appel. */
const TAILLE_MAX_PASSAGE = 3500;

/** Nombre maximal d'exigences analysées par appel pour l'analyse d'impact. */
const LOT_IMPACT = 5;

const dataSourceIds = new Map<string, string>();

// ==================================================
// 2. SCHÉMAS (Zod)
// ==================================================

// NB : pas de min/max sur les nombres, certains modèles les refusent.
// Les bornes sont appliquées par le code (voir clamp).

const TexteSchema = z.object({
  nom: z.string().min(1),
  source: z.string().min(1),
  url: z.string().nullable(),
  dateEntreeEnVigueur: z.string().nullable(),
});

/** Ce que l'IA renvoie pour une exigence (l'ID est local : E1, E2... ; l'article est calculé par le code). */
const ExigenceIASchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  citation: z.string().min(1),
  destinataires: z.array(z.string()),
  echeance: z.string().nullable(),
  sanction: z.string().nullable(),
  confiance: z.number(),
  criticite: z.string().min(1),
});

const ControleSchema = z.object({
  nom: z.string().min(1),
  type: z.string().min(1),
  etat: z.string().min(1),
  exigences: z.array(z.string()),
});

const RisqueSchema = z.object({
  nom: z.string().min(1),
  impact: z.string().min(1),
  probabilite: z.string().min(1),
  exigence: z.string().min(1),
});

const JurisprudenceSchema = z.object({
  nom: z.string().min(1),
  juridiction: z.string().min(1),
  resume: z.string().min(1),
  exigences: z.array(z.string()),
});

const ActionSchema = z.object({
  nom: z.string().min(1),
  responsable: z.string().nullable(),
  echeance: z.string().nullable(),
  exigences: z.array(z.string()),
});

/** Structure finale (après traitement par le code) utilisée par Notion et par les matrices. */
const ExtractionSchema = z.object({
  texte: TexteSchema,

  exigences: z.array(
    ExigenceIASchema.extend({
      article: z.string().min(1),
      statut: z.string().min(1),
      texteOrigine: z.array(z.string()),
    }),
  ),

  controles: z.array(ControleSchema),
  risques: z.array(RisqueSchema),
  jurisprudence: z.array(JurisprudenceSchema),
  actions: z.array(ActionSchema),
});

type Extraction = z.infer<typeof ExtractionSchema>;

/** Réponse brute de l'IA pour UN passage du texte (peut ne contenir aucune exigence). */
const PassageSchema = z.object({
  exigences: z.array(ExigenceIASchema),
  controles: z.array(ControleSchema),
  risques: z.array(RisqueSchema),
  jurisprudence: z.array(JurisprudenceSchema),
  actions: z.array(ActionSchema),
});

type PassageIA = z.infer<typeof PassageSchema>;

/**
 * Appel de rattrapage : impose au moins un contrôle, un risque et une action.
 * Utilisé seulement si l'extraction d'un passage a renvoyé une de ces listes vide.
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

  risques: z.array(RisqueSchema).min(1),

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

// ----- Module 4 : gouvernance TOGAF / ITIL -----

const CADRES = ["TOGAF", "ITIL", "Hybride"] as const;
type Cadre = (typeof CADRES)[number];

/** Éléments de TOGAF (ADM) auxquels une exigence peut être rattachée. */
const PHASES_TOGAF = [
  "Phase préliminaire (Preliminary)",
  "Phase A — Vision d'architecture",
  "Phase B — Architecture métier",
  "Phase C — Architectures des systèmes d'information (données et applications)",
  "Phase D — Architecture technologique",
  "Phase E — Opportunités et solutions",
  "Phase F — Planification de la migration",
  "Phase G — Gouvernance de la mise en œuvre",
  "Phase H — Gestion des changements d'architecture",
  "Gestion des exigences (Requirements Management)",
];

/** Pratiques d'ITIL 4 auxquelles une exigence peut être rattachée. */
const PRATIQUES_ITIL = [
  "Gestion des risques (Risk management)",
  "Gestion de la sécurité de l'information (Information security management)",
  "Gestion des fournisseurs (Supplier management)",
  "Gestion des relations (Relationship management)",
  "Gestion de la continuité de service (Service continuity management)",
  "Gestion des niveaux de service (Service level management)",
  "Gestion des incidents (Incident management)",
  "Gestion des problèmes (Problem management)",
  "Habilitation des changements (Change enablement)",
  "Surveillance et gestion des événements (Monitoring and event management)",
  "Gestion des actifs informatiques (IT asset management)",
  "Gestion de la configuration des services (Service configuration management)",
  "Mesure et reporting (Measurement and reporting)",
  "Amélioration continue (Continual improvement)",
  "Gestion de l'architecture (Architecture management)",
  "Gestion du portefeuille (Portfolio management)",
];

/** Recommandation globale de l'IA (un seul appel). */
const RecommandationSchema = z.object({
  recommandation: z.enum(["TOGAF", "ITIL", "Hybride"]),
  justification: z.string(),
  criteres: z.array(
    z.object({
      critere: z.string(),
      togaf: z.string(),
      itil: z.string(),
      avantage: z.enum(["TOGAF", "ITIL", "Équivalent"]),
    }),
  ),
  repartition: z.string(),
  pointsDeVigilance: z.array(z.string()),
  confiance: z.number(),
});

/** Rattachement de chaque exigence à un élément du cadre (par lots). */
const CorrespondanceSchema = z.object({
  correspondances: z.array(
    z.object({
      exigence: z.string().min(1),
      cadre: z.enum(["TOGAF", "ITIL"]),
      element: z.string(),
      action: z.string(),
    }),
  ),
});

type Recommandation = z.infer<typeof RecommandationSchema>;
type Correspondance = z.infer<typeof CorrespondanceSchema>["correspondances"][number];

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
      `⚠️  ${ORGANISATION_FILE} introuvable : un profil FICTIF a été créé. ` +
      "Adapte-le à ton cas (processus, systèmes, contrôles existants...).",
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

/** Choisit une option Select valide ; si l'IA en a inventé une, on prend la première et on prévient. */
function coerceSelect(valeur: string, options: string[], champ: string): string {
  const trouvee = options.find(
    option =>
      option.toLocaleLowerCase("fr") === valeur.trim().toLocaleLowerCase("fr"),
  );

  if (trouvee) return trouvee;

  console.warn(
    `⚠️  Valeur « ${valeur} » inconnue pour ${champ} : remplacée par « ${options[0]} ».`,
  );

  return options[0];
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
// 7. DÉCOUPAGE DU TEXTE (articles, paragraphes, passages)
// ==================================================

type Paragraphe = { numero: string; texte: string };

type Passage = {
  /** Identifiant utilisé dans les IDs d'exigences, ex. "28", "28-P2". */
  id: string;
  numeroArticle: string;
  reference: string;
  titre: string | null;
  label: string;
  contenu: string;
  paragraphes: Paragraphe[];
  /** Vrai si les paragraphes portent une numérotation officielle (« 1. », « 2. »...). */
  numerotes: boolean;
};

function normaliserNumeroArticle(brut: string): string {
  const numero = brut.trim().toLowerCase();

  if (numero === "premier" || numero === "1er") return "1";

  return numero.replace(/\s+/g, "").toUpperCase();
}

/** "6" devient "06" ; "28BIS" devient "28BIS" : garde l'ordre alphabétique des IDs. */
function formaterNumeroPourId(numero: string): string {
  const match = numero.match(/^(\d+)(.*)$/);
  return match ? `${match[1].padStart(2, "0")}${match[2]}` : numero;
}

/**
 * Découpe le contenu d'un article en paragraphes.
 * - Si le texte contient des paragraphes numérotés officiellement (« 1.  ... », « 2.  ... ») :
 *   le numéro officiel est conservé.
 * - Sinon : un paragraphe par bloc séparé par une ligne vide (numérotation interne, non officielle).
 */
function decouperEnParagraphes(
  contenu: string,
): { paragraphes: Paragraphe[]; numerotes: boolean } {
  const lignes = contenu.split("\n");
  const motifNumerote = /^\s*(\d+)\.\s+\S/;

  const nombreNumerotes = lignes.filter(ligne => motifNumerote.test(ligne)).length;

  if (nombreNumerotes >= 2) {
    const paragraphes: Paragraphe[] = [];
    const introduction: string[] = [];
    let courant: Paragraphe | null = null;

    for (const ligne of lignes) {
      const match = ligne.match(motifNumerote);

      if (match) {
        courant = { numero: match[1], texte: ligne.trim() };
        paragraphes.push(courant);
      } else if (courant) {
        courant.texte += `\n${ligne}`;
      } else {
        introduction.push(ligne);
      }
    }

    // Texte placé avant le paragraphe « 1. » (titre, chapeau) : rattaché au premier paragraphe.
    const chapeau = introduction.join("\n").trim();
    if (chapeau && paragraphes.length > 0) {
      paragraphes[0].texte = `${chapeau}\n${paragraphes[0].texte}`;
    }

    return {
      paragraphes: paragraphes.map(p => ({ ...p, texte: p.texte.trim() })),
      numerotes: true,
    };
  }

  const blocs = contenu
    .split(/\n\s*\n/)
    .map(bloc => bloc.trim())
    .filter(Boolean);

  return {
    paragraphes: blocs.map((texte, index) => ({
      numero: String(index + 1),
      texte,
    })),
    numerotes: false,
  };
}

/**
 * Découpe un document réglementaire en passages d'analyse.
 *
 * 1. par article (« Article 1 », « Article 1er », « Article 28 bis », « ARTICLE 28 — Titre ») ;
 * 2. puis, si un article est long, en groupes de paragraphes de TAILLE_MAX_PASSAGE caractères au plus.
 *
 * Si aucun titre d'article n'est reconnu, le texte entier est découpé par paragraphes.
 */
function decouperParArticle(document: string): Passage[] {
  const lignes = document.replace(/\r\n?/g, "\n").split("\n");

  // Reconnaît : « Article 28 », « ARTICLE 28 — Titre », « Article 28. Titre »,
  // « Article 28 Titre » (titre commençant par une majuscule), « ## Article 28 », « **Article 28** ».
  // Une phrase du type « Article 5 du règlement prévoit… » (minuscule) n'est PAS un titre.
  const motifArticle =
    /^[\s#*>_]*(?:Article|ARTICLE)\s+(premier|1er|\d+[A-Za-z]?(?:\s+(?:bis|ter|quater))?)\b[\s*_]*(?:[-–—.:]\s*(.*?)|\s+([A-ZÀ-ÖØ-Þ].{0,150}?))?[\s*_]*$/;

  type Section = { numero: string; titre: string | null; lignes: string[] };

  const sections: Section[] = [];
  const avantPremierArticle: string[] = [];
  let courante: Section | null = null;

  for (const ligne of lignes) {
    const match = ligne.match(motifArticle);

    if (match) {
      courante = {
        numero: normaliserNumeroArticle(match[1]),
        titre: (match[2] ?? match[3])?.trim() || null,
        lignes: [],
      };
      sections.push(courante);
    } else if (courante) {
      courante.lignes.push(ligne);
    } else {
      avantPremierArticle.push(ligne);
    }
  }

  if (sections.length === 0) {
    console.warn(
      "⚠️  Aucun intitulé « Article N » reconnu dans le document : il est traité comme un bloc unique. " +
      "Les exigences auront pour article « Texte complet » (traçabilité réduite). " +
      "Vérifie que chaque article commence par une ligne du type « Article 28 » ou « Article 28 — Titre ».",
    );

    sections.push({ numero: "0", titre: null, lignes });
  } else if (avantPremierArticle.join("").trim()) {
    console.warn(
      "ℹ️  Du texte précède le premier article : il sert aux métadonnées du texte, " +
      "mais n'est pas analysé comme article.",
    );
  }

  const passages: Passage[] = [];
  const idsVus = new Map<string, number>();

  for (const section of sections) {
    const contenu = section.lignes.join("\n").trim();
    if (!contenu) continue;

    const reference = section.numero === "0" ? "Texte complet" : `Article ${section.numero}`;
    const { paragraphes, numerotes } = decouperEnParagraphes(contenu);

    // Regroupe les paragraphes en passages de taille raisonnable.
    const groupes: Paragraphe[][] = [];
    let groupe: Paragraphe[] = [];
    let taille = 0;

    for (const paragraphe of paragraphes) {
      if (groupe.length > 0 && taille + paragraphe.texte.length > TAILLE_MAX_PASSAGE) {
        groupes.push(groupe);
        groupe = [];
        taille = 0;
      }

      groupe.push(paragraphe);
      taille += paragraphe.texte.length;
    }

    if (groupe.length > 0) groupes.push(groupe);

    // ID unique même si le même numéro d'article apparaît plusieurs fois dans le document.
    const numeroPourId = formaterNumeroPourId(section.numero);
    const occurrence = (idsVus.get(numeroPourId) ?? 0) + 1;
    idsVus.set(numeroPourId, occurrence);
    const base = occurrence > 1 ? `${numeroPourId}-D${occurrence}` : numeroPourId;

    groupes.forEach((paragraphesDuGroupe, index) => {
      const decoupe = groupes.length > 1;

      const premier = paragraphesDuGroupe[0].numero;
      const dernier = paragraphesDuGroupe[paragraphesDuGroupe.length - 1].numero;

      const etendue =
        decoupe && numerotes
          ? ` (§${premier}${premier !== dernier ? `–§${dernier}` : ""})`
          : decoupe
            ? ` (partie ${index + 1}/${groupes.length})`
            : "";

      passages.push({
        id: decoupe ? `${base}-P${index + 1}` : base,
        numeroArticle: section.numero,
        reference,
        titre: section.titre,
        label: `${reference}${etendue}`,
        contenu: paragraphesDuGroupe.map(p => p.texte).join("\n\n"),
        paragraphes: paragraphesDuGroupe,
        numerotes,
      });
    });
  }

  return passages;
}

/**
 * Trouve le paragraphe (numéro officiel) qui contient la citation. Calculé par le code, jamais par l'IA.
 * Renvoie null si les paragraphes ne sont pas numérotés officiellement, ou si la citation
 * est introuvable ou ambiguë.
 */
function localiserParagraphe(citation: string, passage: Passage): string | null {
  if (!passage.numerotes) return null;

  const c = normalizeName(citation);
  if (c.length < 15) return null;

  const contenant = (extrait: string) =>
    passage.paragraphes.filter(p => normalizeName(p.texte).includes(extrait));

  let trouves = contenant(c);

  // Citation à cheval sur deux paragraphes : on se base sur son début.
  if (trouves.length === 0) trouves = contenant(c.slice(0, 40));

  return trouves.length === 1 ? trouves[0].numero : null;
}

/** Code court du texte, utilisé dans les identifiants (ex. DORA). Surchargeable avec CODE_TEXTE dans .env. */
function codeTexte(document: string): string {
  const impose = process.env.CODE_TEXTE?.trim();
  if (impose) return impose.toUpperCase();

  const candidats = [...document.slice(0, 1500).matchAll(/\(([A-Z][A-Z0-9]{1,9})\)/g)]
    .map(match => match[1])
    .filter(code => !["UE", "CE", "EU", "UK"].includes(code));

  return candidats[0] ?? "TXT";
}

// ==================================================
// 8. VALIDATION DES RELATIONS
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
// 9. ANTI-DOUBLONS
// ==================================================

type Existing = {
  id: string;
  title: string;
  article?: string;
  description?: string;
  citation?: string;
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

/** Fusionne les éléments de même nom en réunissant leurs exigences (un contrôle peut couvrir plusieurs articles). */
function fusionnerParNom<T extends { nom: string; exigences: string[] }>(items: T[]): T[] {
  const parNom = new Map<string, T>();

  for (const item of items) {
    const cle = normalizeName(item.nom);
    if (!cle) continue;

    const existant = parNom.get(cle);

    if (existant) {
      existant.exigences = [...new Set([...existant.exigences, ...item.exigences])];
    } else {
      parNom.set(cle, { ...item, exigences: [...item.exigences] });
    }
  }

  return [...parNom.values()];
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

  extraction.controles = fusionnerParNom(extraction.controles);
  extraction.jurisprudence = fusionnerParNom(extraction.jurisprudence);
  extraction.actions = fusionnerParNom(extraction.actions);
  extraction.risques = dedupeBy(
    extraction.risques,
    r => `${normalizeName(r.nom)}|${r.exigence}`,
  );
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
    citation?: string;
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
        citation: extra?.citation
          ? plainText(props[extra.citation])
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
 * Protection n°2 : crée la page seulement si aucune page du même titre
 * (ou d'un titre proche, lié à la même exigence) n'existe.
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
 * Une exigence existe déjà si :
 * - son ID est identique, ou
 * - sa citation (extrait exact du texte, très stable) est identique à celle d'une page existante, ou
 * - l'article est le même et la description très proche.
 */
function findExistingExigence(
  existing: Existing[],
  item: Extraction["exigences"][number],
): Existing | undefined {
  const article = normalizeName(item.article.trim().slice(0, 100));
  const citation = normalizeName(item.citation);

  return existing.find(
    e =>
      normalizeName(e.title) === normalizeName(item.id) ||
      (citation.length >= 15 &&
        e.citation &&
        normalizeName(e.citation) === citation) ||
      (e.article &&
        e.description &&
        normalizeName(e.article) === article &&
        similarity(e.description, item.description) >= SEUIL_SIMILARITE),
  );
}

// ==================================================
// 10. CACHE, VÉRIFICATION DES CITATIONS, ANALYSE D'IMPACT
// ==================================================

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : min)));

const clamp01 = (value: number) =>
  Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

function empreinte(valeur: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(valeur))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Exécute `produire` seulement si aucun résultat n'est mémorisé pour cette clé.
 * Même entrée => même réponse de l'IA => aucun doublon d'un lancement à l'autre.
 * `estComplet` permet de ne PAS mémoriser un résultat incomplet (il sera retenté au lancement suivant).
 */
async function avecCache<T>(
  cle: string,
  forcer: boolean,
  produire: () => Promise<T>,
  estComplet: (valeur: T) => boolean = () => true,
): Promise<{ valeur: T; depuisCache: boolean }> {
  const fichier = resolve(CACHE_DIR, `${cle}.json`);

  if (!forcer) {
    try {
      const contenu = await readFile(fichier, "utf8");
      return { valeur: JSON.parse(contenu) as T, depuisCache: true };
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        console.warn("⚠️  Cache illisible, la réponse est redemandée :", error?.message);
      }
    }
  }

  const valeur = await produire();

  if (estComplet(valeur)) {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(fichier, JSON.stringify(valeur, null, 2) + "\n", "utf-8");
  }

  return { valeur, depuisCache: false };
}

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

function analyseParDefaut(id: string): AnalyseImpact {
  return {
    exigence: id,
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
  };
}

/** Analyse d'impact d'un lot d'exigences. Ne renvoie que ce que l'IA a produit (valeurs nettoyées). */
async function analyserImpact(
  lot: Extraction["exigences"],
  organisation: Organisation,
): Promise<AnalyseImpact[]> {
  const exigences = lot.map(item => ({
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

  const idsDuLot = new Set(lot.map(item => item.id));

  return object.analyses
    .filter(analyse => idsDuLot.has(analyse.exigence))
    .map(analyse => ({
      ...analyse,
      processus: garder(analyse.processus, processus),
      systemes: garder(analyse.systemes, systemes),
      donnees: garder(analyse.donnees, donnees),
      contrats: garder(analyse.contrats, contrats),
      controlesExistants: garder(analyse.controlesExistants, controles),
      graviteResiduelle: clamp(analyse.graviteResiduelle, 1, 4),
      vraisemblanceResiduelle: clamp(analyse.vraisemblanceResiduelle, 1, 4),
      confiance: clamp01(analyse.confiance),
    }));
}

/** Analyse d'impact par lots de LOT_IMPACT exigences, avec cache (un lot incomplet n'est pas mémorisé). */
async function analyserParLots(
  exigences: Extraction["exigences"],
  organisation: Organisation,
  forcer: boolean,
): Promise<AnalyseImpact[]> {
  const resultat: AnalyseImpact[] = [];

  for (let debut = 0; debut < exigences.length; debut += LOT_IMPACT) {
    const lot = exigences.slice(debut, debut + LOT_IMPACT);

    const cle = empreinte({
      v: VERSION_PROMPT,
      type: "impact",
      organisation,
      lot: lot.map(item => ({
        id: item.id,
        article: item.article,
        description: item.description,
        sanction: item.sanction,
        criticite: item.criticite,
      })),
    });

    const { valeur, depuisCache } = await avecCache<AnalyseImpact[]>(
      cle,
      forcer,
      () => analyserImpact(lot, organisation),
      analyses => lot.every(item => analyses.some(a => a.exigence === item.id)),
    );

    console.log(
      `    analyse d'impact : ${lot.length} exigence(s)${depuisCache ? " (cache)" : ""}`,
    );

    resultat.push(...valeur);
  }

  return resultat;
}

// ==================================================
// 11. EXTRACTION PAR PASSAGE (avec cache)
// ==================================================

type OptionsSelect = {
  criticite: string[];
  typeControle: string[];
  etatControle: string[];
  impact: string[];
  probabilite: string[];
  juridiction: string[];
};

type ContextePassage = {
  code: string;
  texteNom: string;
  options: OptionsSelect;
  statutInitial: string;
};

type ResultatPassage = {
  exigences: Extraction["exigences"];
  controles: Extraction["controles"];
  risques: Extraction["risques"];
  jurisprudence: Extraction["jurisprudence"];
  actions: Extraction["actions"];
};

/** Appel de l'IA pour UN passage : réponse brute, mémorisée dans data/cache. */
async function extrairePassageBrut(
  passage: Passage,
  ctx: ContextePassage,
  forcer: boolean,
): Promise<{ valeur: PassageIA; depuisCache: boolean }> {
  const cle = empreinte({
    v: VERSION_PROMPT,
    type: "passage",
    id: passage.id,
    contenu: passage.contenu,
    texteNom: ctx.texteNom,
    options: ctx.options,
  });

  return avecCache<PassageIA>(cle, forcer, async () => {
    const { object } = await generateObject({
      model: openai("gpt-4o-mini"),
      schema: PassageSchema,
      temperature: 0,
      prompt: `
Tu es un assistant GRC spécialisé en conformité réglementaire.

Tu analyses UN SEUL PASSAGE d'un texte réglementaire. N'utilise pas tes connaissances
externes pour compléter le contenu fourni.

TEXTE : ${ctx.texteNom}
PASSAGE ANALYSÉ : ${passage.label}${passage.titre ? ` — ${passage.titre}` : ""}

CONTENU DU PASSAGE :
---
${passage.contenu}
---

RÈGLES IMPÉRATIVES :

1. EXTRACTION
- Extrais uniquement les obligations présentes dans le contenu ci-dessus.
- Si le passage ne contient AUCUNE obligation exploitable, renvoie des listes vides.
- Une exigence par obligation distincte. Ne reformule jamais deux fois la même obligation.
- N'invente ni texte de loi, ni citation, ni sanction, ni décision de justice.

2. IDENTIFIANTS
- Identifie chaque exigence par un ID LOCAL : E1, E2, E3... dans l'ordre du passage.
- Utilise exactement ces ID dans les relations des contrôles, risques, actions
  et jurisprudences. Les identifiants définitifs sont attribués ensuite par le code.

3. CHAMPS DE CHAQUE EXIGENCE
- description : l'obligation reformulée clairement, en une phrase.
- citation : extrait copié MOT POUR MOT du contenu (une ou deux phrases au plus),
  provenant d'UN SEUL paragraphe. Ne reformule pas, ne résume pas, ne combine pas
  deux paragraphes.
- destinataires : personnes ou entités visées par l'obligation.
- echeance : délai ou date UNIQUEMENT s'il est explicitement écrit, sinon null.
- sanction : sanction UNIQUEMENT si elle est explicitement écrite, sinon null.
- confiance : nombre entre 0 et 1.

4. CONTRÔLES, RISQUES, ACTIONS
- Pour chaque exigence, propose au moins un contrôle pertinent, un risque de
  non-conformité et une action corrective. Ce sont des hypothèses d'analyse,
  pas des citations du texte. Aucun doublon.
- Un contrôle ou une action peut couvrir plusieurs exigences de CE passage.
- Le champ "exigence" d'un risque contient l'ID local d'UNE seule exigence.
- N'invente ni responsable ni échéance d'action : utilise null.
- N'ajoute une jurisprudence que si une décision identifiable est explicitement
  mentionnée dans le contenu. Sinon, renvoie [].

5. OPTIONS AUTORISÉES
Choisis exclusivement parmi les valeurs suivantes pour les champs Select :

Criticité : ${ctx.options.criticite.join(" | ")}
Type de contrôle : ${ctx.options.typeControle.join(" | ")}
État du contrôle : ${ctx.options.etatControle.join(" | ")}
Impact : ${ctx.options.impact.join(" | ")}
Probabilité : ${ctx.options.probabilite.join(" | ")}
Juridiction : ${ctx.options.juridiction.join(" | ")}
`,
    });

    return object;
  });
}

/** Appel de rattrapage (mémorisé) : l'IA a extrait des exigences mais laissé des listes vides. */
async function completerPassage(
  exigences: Extraction["exigences"],
  ctx: ContextePassage,
  forcer: boolean,
) {
  const entree = exigences.map(item => ({
    id: item.id,
    article: item.article,
    description: item.description,
    criticite: item.criticite,
  }));

  const cle = empreinte({
    v: VERSION_PROMPT,
    type: "complement",
    texteNom: ctx.texteNom,
    options: {
      typeControle: ctx.options.typeControle,
      etatControle: ctx.options.etatControle,
      impact: ctx.options.impact,
      probabilite: ctx.options.probabilite,
    },
    exigences: entree,
  });

  const { valeur } = await avecCache(cle, forcer, async () => {
    const { object } = await generateObject({
      model: openai("gpt-4o-mini"),
      schema: AnalyseSchema,
      temperature: 0,
      prompt: `
Tu es un assistant GRC spécialisé en conformité réglementaire.

À partir des exigences ci-dessous (extraites du texte ${ctx.texteNom}),
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

Type de contrôle : ${ctx.options.typeControle.join(" | ")}
État du contrôle : ${ctx.options.etatControle.join(" | ")}
Impact : ${ctx.options.impact.join(" | ")}
Probabilité : ${ctx.options.probabilite.join(" | ")}

EXIGENCES :
${JSON.stringify(entree, null, 2)}
`,
    });

    return object;
  });

  return valeur;
}

/**
 * Transforme la réponse brute de l'IA en données définitives.
 * Tout ce qui est fait ici est DÉTERMINISTE (IDs, article/paragraphe, options Select) :
 * c'est le code, pas l'IA, qui attribue les identifiants et les références.
 */
function construirePassage(
  passage: Passage,
  brut: PassageIA,
  ctx: ContextePassage,
): ResultatPassage {
  const alias = new Map<string, string>();

  const exigences: Extraction["exigences"] = brut.exigences.map((item, index) => {
    const id = `EX-${ctx.code}-${passage.id}-${String(index + 1).padStart(2, "0")}`;

    if (!alias.has(item.id)) alias.set(item.id, id);

    // Le paragraphe est trouvé en cherchant la citation dans le texte : exact, jamais deviné.
    const paragraphe = localiserParagraphe(item.citation, passage);

    return {
      id,
      article: cleanSelectName(
        paragraphe ? `${passage.reference} §${paragraphe}` : passage.reference,
      ),
      description: item.description,
      citation: item.citation,
      destinataires: item.destinataires,
      echeance: item.echeance,
      sanction: item.sanction,
      confiance: clamp01(item.confiance),
      criticite: coerceSelect(item.criticite, ctx.options.criticite, "Criticité"),
      statut: ctx.statutInitial,
      texteOrigine: [],
    };
  });

  const remap = (ids: string[]) => [
    ...new Set(
      ids
        .map(id => alias.get(id))
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  return {
    exigences,

    controles: brut.controles.map(c => ({
      ...c,
      type: coerceSelect(c.type, ctx.options.typeControle, "Type de contrôle"),
      etat: coerceSelect(c.etat, ctx.options.etatControle, "État du contrôle"),
      exigences: remap(c.exigences),
    })),

    risques: brut.risques
      .filter(r => alias.has(r.exigence))
      .map(r => ({
        ...r,
        exigence: alias.get(r.exigence)!,
        impact: coerceSelect(r.impact, ctx.options.impact, "Impact"),
        probabilite: coerceSelect(r.probabilite, ctx.options.probabilite, "Probabilité"),
      })),

    jurisprudence: brut.jurisprudence.map(j => ({
      ...j,
      juridiction: coerceSelect(j.juridiction, ctx.options.juridiction, "Juridiction"),
      exigences: remap(j.exigences),
    })),

    actions: brut.actions.map(a => ({
      ...a,
      exigences: remap(a.exigences),
    })),
  };
}

/** Extraction complète d'un passage : appel IA (en cache), IDs par le code, rattrapage éventuel. */
async function traiterPassage(
  passage: Passage,
  ctx: ContextePassage,
  forcer: boolean,
): Promise<{ resultat: ResultatPassage; depuisCache: boolean }> {
  const { valeur: brut, depuisCache } = await extrairePassageBrut(passage, ctx, forcer);

  const resultat = construirePassage(passage, brut, ctx);

  // Rattrapage si l'IA a extrait des exigences mais laissé des listes vides.
  if (
    resultat.exigences.length > 0 &&
    (resultat.controles.length === 0 ||
      resultat.risques.length === 0 ||
      resultat.actions.length === 0)
  ) {
    console.log(`    ${passage.label} : analyse complémentaire (contrôles, risques, actions)`);

    const complement = await completerPassage(resultat.exigences, ctx, forcer);
    const ids = new Set(resultat.exigences.map(e => e.id));

    if (resultat.controles.length === 0) {
      resultat.controles = complement.controles.map(c => ({
        ...c,
        type: coerceSelect(c.type, ctx.options.typeControle, "Type de contrôle"),
        etat: coerceSelect(c.etat, ctx.options.etatControle, "État du contrôle"),
        exigences: c.exigences.filter(id => ids.has(id)),
      }));
    }

    if (resultat.risques.length === 0) {
      resultat.risques = complement.risques
        .filter(r => ids.has(r.exigence))
        .map(r => ({
          ...r,
          impact: coerceSelect(r.impact, ctx.options.impact, "Impact"),
          probabilite: coerceSelect(r.probabilite, ctx.options.probabilite, "Probabilité"),
        }));
    }

    if (resultat.actions.length === 0) {
      resultat.actions = complement.actions.map(a => ({
        ...a,
        exigences: a.exigences.filter(id => ids.has(id)),
      }));
    }
  }

  return { resultat, depuisCache };
}

// ==================================================
// 12. MATRICES GRC (M1 à M5) — EXPORT EXCEL
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
  gouvernance?: Gouvernance;
};

async function exporterMatrices(ctx: ContexteMatrices): Promise<string> {
  const { extraction, organisation, analyses, verifications, statuts, gouvernance } = ctx;

  const libelle = (liste: Element[], ids: string[]) =>
    ids.length === 0
      ? "—"
      : ids
          .map(id => {
            const element = liste.find(e => e.id === id);
            return element ? `${id} – ${element.nom}` : id;
          })
          .join("\n");

  const analyseDe = (id: string) => analyses.get(id) ?? analyseParDefaut(id);

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
      mesures: analyse.mesuresResiduelles || "—",
      gravite: analyse.graviteResiduelle,
      vraisemblance: analyse.vraisemblanceResiduelle,
      confiance: analyse.confiance,
    });

    const numero = ligne.number;

    ligne.getCell("niveau").value = {
      formula: `${lettreGravite}${numero}*${lettreVraisemblance}${numero}`,
      result: analyse.graviteResiduelle * analyse.vraisemblanceResiduelle,
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

  if (gouvernance) ajouterFeuillesGouvernance(workbook, gouvernance, extraction.exigences);

  const chemin = resolve(...MATRICES_FILE);
  await mkdir(resolve(MATRICES_FILE[0], MATRICES_FILE[1]), { recursive: true });
  await workbook.xlsx.writeFile(chemin);

  return chemin;
}

// ==================================================
// 12 bis. MODULE 4 — GOUVERNANCE TOGAF / ITIL
// ==================================================
// Principe : l'IA PROPOSE, l'humain TRANCHE.
//  - l'agent n'écrit jamais la décision finale ;
//  - la décision est lue dans data/decision_gouvernance.json, fichier que seul un humain remplit.

const DECISION_GOUVERNANCE_FILE = ["data", "decision_gouvernance.json"];
const GOUVERNANCE_FILE = ["data", "gouvernance.json"];
const PLAN_GOUVERNANCE_FILE = ["data", "plan_gouvernance.md"];
const LOT_GOUVERNANCE = 10;

type ExigenceGouv = Extraction["exigences"][number];

type DecisionHumaine = {
  decisionHumaine: Cadre | null;
  decideur: string | null;
  date: string | null;
  justification: string | null;
};

type Gouvernance = {
  recommandation: Recommandation;
  correspondances: Correspondance[];
  nonRattachees: string[];
  decision: DecisionHumaine;
};

function elementsDuCadre(cadre: "TOGAF" | "ITIL"): readonly string[] {
  return cadre === "TOGAF" ? PHASES_TOGAF : PRATIQUES_ITIL;
}

/** Retrouve l'élément officiel de la liste fermée (tolère casse/accents/ponctuation). */
function resoudreElement(cadre: "TOGAF" | "ITIL", element: string): string | null {
  const cible = normalizeName(element);
  if (!cible) return null;

  const liste = elementsDuCadre(cadre);

  return (
    liste.find(e => normalizeName(e) === cible) ??
    liste.find(e => normalizeName(e).includes(cible) || cible.includes(normalizeName(e))) ??
    null
  );
}

/** Lit la décision humaine ; crée le modèle vide s'il n'existe pas. L'agent ne l'écrase JAMAIS. */
async function chargerDecisionHumaine(): Promise<DecisionHumaine> {
  const chemin = resolve(...DECISION_GOUVERNANCE_FILE);
  const vide: DecisionHumaine = {
    decisionHumaine: null,
    decideur: null,
    date: null,
    justification: null,
  };

  try {
    const brut = JSON.parse(await readFile(chemin, "utf8"));
    const choix = brut?.decisionHumaine;

    if (choix !== null && choix !== undefined && !CADRES.includes(choix)) {
      console.warn(
        `⚠️  decision_gouvernance.json : « ${choix} » n'est pas valide (attendu : ${CADRES.join(", ")} ou null). Décision ignorée.`,
      );
      return vide;
    }

    return {
      decisionHumaine: choix ?? null,
      decideur: brut?.decideur ?? null,
      date: brut?.date ?? null,
      justification: brut?.justification ?? null,
    };
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      console.warn("⚠️  decision_gouvernance.json illisible :", error?.message);
      return vide;
    }
  }

  await mkdir(resolve(DECISION_GOUVERNANCE_FILE[0]), { recursive: true });
  await writeFile(
    chemin,
    JSON.stringify(
      {
        _aide:
          "À remplir PAR UN HUMAIN. decisionHumaine : \"TOGAF\", \"ITIL\" ou \"Hybride\" (null = pas encore décidé). L'agent ne modifie jamais ce fichier.",
        ...vide,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  console.log(`  Fichier de décision humaine créé (vide) : ${chemin}`);

  return vide;
}

async function recommanderCadre(
  exigences: ExigenceGouv[],
  organisation: Organisation,
  forcer: boolean,
): Promise<{ valeur: Recommandation; depuisCache: boolean }> {
  const resume = exigences.map(e => ({
    id: e.id,
    article: e.article,
    criticite: e.criticite,
    echeance: e.echeance,
    description: e.description.slice(0, 220),
  }));

  const cle = empreinte({
    v: VERSION_PROMPT,
    type: "gouv-reco",
    exigences: resume,
    organisation: [organisation.nom, organisation.secteur, organisation.description],
  });

  return avecCache<Recommandation>(cle, forcer, async () => {
    const { object } = await generateObject({
      model: openai("gpt-4o-mini"),
      schema: RecommandationSchema,
      temperature: 0,
      prompt: `
Tu es un consultant en gouvernance IT / architecture d'entreprise.

À partir des EXIGENCES RÉGLEMENTAIRES ci-dessous, PROPOSE le cadre de gouvernance le plus pertinent
pour les piloter : TOGAF, ITIL ou Hybride. Tu ne décides pas : un humain tranchera après lecture de ta proposition.

Repères :
- TOGAF = architecture d'entreprise (cartographie métier/données/applications/technologie, trajectoire cible,
  gouvernance de la mise en œuvre, gestion des changements d'architecture). Pertinent quand les exigences imposent
  de structurer, cartographier ou transformer le système d'information.
- ITIL 4 = gestion des services en exploitation (incidents, problèmes, changements, fournisseurs, continuité,
  niveaux de service, amélioration continue). Pertinent quand les exigences portent sur l'exploitation et le suivi courant.
- Hybride = les deux familles d'exigences sont significatives ; précise alors QUI prend quoi dans « repartition ».

RÈGLES :
- Base-toi uniquement sur les exigences fournies et le profil de l'organisation. N'invente aucune exigence.
- « criteres » : 4 à 6 critères de comparaison (ex. nature des exigences, horizon temporel, maturité, parties prenantes,
  effort de mise en œuvre), chacun avec ce que TOGAF et ITIL apportent ici, et lequel a l'avantage.
- « repartition » : phrase qui dit quelles exigences relèvent de quel cadre (cite des IDs).
- « pointsDeVigilance » : risques ou limites de ta proposition (au moins 2).
- « confiance » : nombre entre 0 et 1.
- Écris en français, sans virgule dans les valeurs d'énumération.

ORGANISATION : ${organisation.nom} — ${organisation.secteur}
${organisation.description}
Processus : ${organisation.processus.map(p => p.nom).join(", ")}
Systèmes : ${organisation.systemes.map(s => s.nom).join(", ")}

EXIGENCES (${resume.length}) :
${JSON.stringify(resume, null, 1)}
`,
    });

    return { ...object, confiance: clamp01(object.confiance) };
  });
}

async function rattacherExigences(
  exigences: ExigenceGouv[],
  forcer: boolean,
): Promise<{ correspondances: Correspondance[]; nonRattachees: string[] }> {
  const connus = new Set(exigences.map(e => e.id));
  const correspondances = new Map<string, Correspondance>();
  /** Libellés hors liste proposés par l'IA, par exigence (sert d'indice au rattrapage). */
  const rejets = new Map<string, string>();

  for (let debut = 0; debut < exigences.length; debut += LOT_GOUVERNANCE) {
    const lot = exigences.slice(debut, debut + LOT_GOUVERNANCE);
    const resume = lot.map(e => ({ id: e.id, article: e.article, description: e.description.slice(0, 260) }));

    const cle = empreinte({ v: VERSION_PROMPT, type: "gouv-corresp", lot: resume });

    const { valeur, depuisCache } = await avecCache<Correspondance[]>(cle, forcer, async () => {
      const { object } = await generateObject({
        model: openai("gpt-4o-mini"),
        schema: CorrespondanceSchema,
        temperature: 0,
        prompt: `
Tu es un consultant en gouvernance IT. Rattache CHAQUE exigence ci-dessous à UN élément d'un cadre de gouvernance.

ÉLÉMENTS TOGAF autorisés (copie le libellé exact) :
${PHASES_TOGAF.map(p => `- ${p}`).join("\n")}

PRATIQUES ITIL 4 autorisées (copie le libellé exact) :
${PRATIQUES_ITIL.map(p => `- ${p}`).join("\n")}

RÈGLES :
- Une seule ligne par exigence, avec « exigence » = l'ID fourni (ex. 28-P1-E1), sans en inventer.
- « cadre » = TOGAF ou ITIL ; « element » = libellé EXACT de la liste du cadre choisi.
- « action » = ce que l'organisation fait concrètement dans ce cadre pour satisfaire l'exigence (une phrase, sans virgule superflue).
- Choisis le cadre où l'exigence se pilote le plus naturellement.

EXIGENCES :
${JSON.stringify(resume, null, 1)}
`,
      });

      return object.correspondances;
    });

    for (const c of valeur) {
      const id = c.exigence.trim();
      if (!connus.has(id)) {
        console.warn(`  ⚠️  Gouvernance : ID inconnu ignoré « ${id} »`);
        continue;
      }
      const element = resoudreElement(c.cadre, c.element);
      if (!element) {
        console.warn(`  ⚠️  Gouvernance : élément hors liste pour ${id} (« ${c.element} »), nouvel essai ciblé`);
        rejets.set(id, c.element);
        continue;
      }
      if (!correspondances.has(id)) {
        correspondances.set(id, { ...c, exigence: id, element });
      }
    }

    console.log(`    rattachement ${lot.length} exigence(s)${depuisCache ? " (cache)" : ""}`);
  }

  // Rattrapage : les exigences sans rattachement valide sont redemandées avec un rappel de la liste fermée.
  const manquantes = exigences.filter(e => !correspondances.has(e.id));

  if (manquantes.length > 0) {
    const resume = manquantes.map(e => ({
      id: e.id,
      article: e.article,
      description: e.description.slice(0, 260),
      reponseInvalide: rejets.get(e.id) ?? null,
    }));

    const cle = empreinte({ v: VERSION_PROMPT, type: "gouv-rattrapage", lot: resume });

    const { valeur, depuisCache } = await avecCache<Correspondance[]>(cle, forcer, async () => {
      const { object } = await generateObject({
        model: openai("gpt-4o-mini"),
        schema: CorrespondanceSchema,
        temperature: 0,
        prompt: `
Tu rattaches des exigences réglementaires à un cadre de gouvernance. Une première tentative a produit un libellé
qui N'EST PAS dans les listes autorisées (voir « reponseInvalide »). Choisis, pour chaque exigence, l'élément
AUTORISÉ le plus proche. Tu ne peux utiliser que ces libellés exacts :

TOGAF :
${PHASES_TOGAF.map(p => `- ${p}`).join("\n")}

ITIL 4 :
${PRATIQUES_ITIL.map(p => `- ${p}`).join("\n")}

Une ligne par exigence (« exigence » = l'ID fourni), « cadre » = TOGAF ou ITIL, « element » = libellé exact,
« action » = ce que l'organisation doit faire (une phrase).

EXIGENCES :
${JSON.stringify(resume, null, 1)}
`,
      });

      return object.correspondances;
    });

    for (const c of valeur) {
      const id = c.exigence.trim();
      const element = resoudreElement(c.cadre, c.element);
      if (connus.has(id) && element && !correspondances.has(id)) {
        correspondances.set(id, { ...c, exigence: id, element });
      }
    }

    console.log(`    rattrapage ${manquantes.length} exigence(s)${depuisCache ? " (cache)" : ""}`);
  }

  return {
    correspondances: exigences
      .map(e => correspondances.get(e.id))
      .filter((c): c is Correspondance => Boolean(c)),
    nonRattachees: exigences.filter(e => !correspondances.has(e.id)).map(e => e.id),
  };
}

async function analyserGouvernance(
  exigences: ExigenceGouv[],
  organisation: Organisation,
  forcer: boolean,
): Promise<Gouvernance> {
  const decision = await chargerDecisionHumaine();

  const reco = await recommanderCadre(exigences, organisation, forcer);
  console.log(`  Proposition de l'IA : ${reco.valeur.recommandation}${reco.depuisCache ? " (cache)" : ""}`);

  const { correspondances, nonRattachees } = await rattacherExigences(exigences, forcer);

  if (nonRattachees.length > 0) {
    console.warn(`  ⚠️  ${nonRattachees.length} exigence(s) non rattachée(s) : ${nonRattachees.join(", ")}`);
  }

  return { recommandation: reco.valeur, correspondances, nonRattachees, decision };
}

function statutDecision(g: Gouvernance): string {
  const { decisionHumaine, decideur } = g.decision;
  if (!decisionHumaine) return "⏳ EN ATTENTE DE DÉCISION HUMAINE";

  const accord =
    decisionHumaine === g.recommandation.recommandation
      ? "conforme à la proposition de l'IA"
      : `DIFFÉRENTE de la proposition de l'IA (${g.recommandation.recommandation})`;

  return `✅ Décidé par ${decideur ?? "(décideur non renseigné)"} : ${decisionHumaine} — ${accord}`;
}

function repartitionParCadre(g: Gouvernance) {
  const compte = { TOGAF: 0, ITIL: 0 };
  for (const c of g.correspondances) compte[c.cadre]++;
  return compte;
}

async function exporterGouvernance(
  g: Gouvernance,
  exigences: ExigenceGouv[],
): Promise<void> {
  const compte = repartitionParCadre(g);
  const parId = new Map(exigences.map(e => [e.id, e]));
  const reco = g.recommandation;

  await mkdir(resolve("data"), { recursive: true });

  await writeFile(
    resolve(...GOUVERNANCE_FILE),
    JSON.stringify(
      {
        propositionIA: reco,
        repartitionCalculee: compte,
        decisionHumaine: g.decision,
        statut: statutDecision(g),
        correspondances: g.correspondances,
        nonRattachees: g.nonRattachees,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );

  // Regroupement par élément de cadre : le « plan » lisible.
  const groupes = new Map<string, Correspondance[]>();
  for (const c of g.correspondances) {
    const cle = `${c.cadre} — ${c.element}`;
    groupes.set(cle, [...(groupes.get(cle) ?? []), c]);
  }

  const lignes: string[] = [
    "# Plan de gouvernance (proposition de l'agent)",
    "",
    `**Statut de la décision :** ${statutDecision(g)}`,
    "",
    "> L'IA propose, l'humain tranche : le cadre retenu est celui inscrit dans `data/decision_gouvernance.json`.",
    "",
    `## Proposition de l'IA : ${reco.recommandation} (confiance ${Math.round(reco.confiance * 100)} %)`,
    "",
    reco.justification,
    "",
    `**Répartition des exigences :** ${reco.repartition}`,
    "",
    `Rattachement calculé : ${compte.TOGAF} exigence(s) côté TOGAF, ${compte.ITIL} côté ITIL.`,
    "",
    "## Comparaison TOGAF / ITIL",
    "",
    "| Critère | TOGAF | ITIL | Avantage |",
    "|---|---|---|---|",
    ...reco.criteres.map(
      c => `| ${c.critere} | ${c.togaf} | ${c.itil} | ${c.avantage} |`,
    ),
    "",
    "## Points de vigilance",
    "",
    ...reco.pointsDeVigilance.map(p => `- ${p}`),
    "",
    "## Rattachement des exigences",
    "",
  ];

  for (const [cle, items] of groupes) {
    lignes.push(`### ${cle}`, "");
    for (const c of items) {
      lignes.push(`- **${c.exigence}** (${parId.get(c.exigence)?.article ?? "?"}) — ${c.action}`);
    }
    lignes.push("");
  }

  if (g.nonRattachees.length > 0) {
    lignes.push("## Non rattachées", "", ...g.nonRattachees.map(id => `- ${id}`), "");
  }

  await writeFile(resolve(...PLAN_GOUVERNANCE_FILE), lignes.join("\n"), "utf-8");

  console.log(`Plan de gouvernance créé : ${resolve(...PLAN_GOUVERNANCE_FILE)}`);
}

function ajouterFeuillesGouvernance(
  workbook: ExcelJS.Workbook,
  g: Gouvernance,
  exigences: ExigenceGouv[],
): void {
  const compte = repartitionParCadre(g);
  const reco = g.recommandation;

  ajouterFeuille(
    workbook,
    "Gouvernance - Synthèse",
    [
      { header: "Rubrique", key: "rubrique", width: 30 },
      { header: "Contenu", key: "contenu", width: 110 },
    ],
    [
      { rubrique: "Statut de la décision", contenu: statutDecision(g) },
      { rubrique: "Proposition de l'IA", contenu: `${reco.recommandation} (confiance ${Math.round(reco.confiance * 100)} %)` },
      { rubrique: "Justification", contenu: reco.justification },
      { rubrique: "Répartition proposée", contenu: reco.repartition },
      { rubrique: "Rattachement calculé", contenu: `TOGAF : ${compte.TOGAF} — ITIL : ${compte.ITIL}` },
      { rubrique: "Décision humaine", contenu: g.decision.decisionHumaine ?? "— (à renseigner dans data/decision_gouvernance.json)" },
      { rubrique: "Décideur / date", contenu: [g.decision.decideur, g.decision.date].filter(Boolean).join(" — ") || "—" },
      { rubrique: "Justification humaine", contenu: g.decision.justification ?? "—" },
      ...reco.criteres.map(c => ({
        rubrique: `Critère : ${c.critere}`,
        contenu: `TOGAF : ${c.togaf}\nITIL : ${c.itil}\nAvantage : ${c.avantage}`,
      })),
      ...reco.pointsDeVigilance.map((p, i) => ({ rubrique: `Point de vigilance ${i + 1}`, contenu: p })),
    ],
  );

  const parId = new Map(exigences.map(e => [e.id, e]));

  ajouterFeuille(
    workbook,
    "Gouvernance - Rattachement",
    [
      { header: "ID Exigence", key: "id", width: 14 },
      { header: "Article", key: "article", width: 18 },
      { header: "Criticité", key: "criticite", width: 12 },
      { header: "Cadre", key: "cadre", width: 10 },
      { header: "Élément du cadre", key: "element", width: 55 },
      { header: "Action à mener", key: "action", width: 70 },
    ],
    g.correspondances.map(c => ({
      id: c.exigence,
      article: parId.get(c.exigence)?.article ?? "",
      criticite: parId.get(c.exigence)?.criticite ?? "",
      cadre: c.cadre,
      element: c.element,
      action: c.action,
    })),
  );
}

// ==================================================
// 13. AGENT PRINCIPAL
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

  // FORCER_EXTRACTION=1 ignore le cache et redemande tout à l'IA.
  const forcer = process.env.FORCER_EXTRACTION === "1";

  if (forcer) {
    console.warn("⚠️  FORCER_EXTRACTION=1 : le cache est ignoré, tout est redemandé à l'IA.");
  }

  const code = codeTexte(document);

  console.log("3/6 — Extraction des données GRC");

  // ---------- Métadonnées du texte : UN seul appel, mémorisé ----------
  const entete = document.slice(0, 3000);

  const { valeur: texteBrut, depuisCache: texteEnCache } = await avecCache(
    empreinte({ v: VERSION_PROMPT, type: "texte", entete, source: options.source }),
    forcer,
    async () => {
      const { object } = await generateObject({
        model: openai("gpt-4o-mini"),
        schema: TexteSchema,
        temperature: 0,
        prompt: `
Tu es un assistant GRC. À partir de l'en-tête du document ci-dessous, renseigne
les informations générales du texte juridique.

RÈGLES IMPÉRATIVES :
- nom : intitulé officiel complet du texte. Si une ligne « SOURCE » existe,
  reprends-la exactement.
- source : choisis exclusivement parmi : ${options.source.join(" | ")}
- url : URL présente dans l'en-tête, sinon null.
- dateEntreeEnVigueur : format YYYY-MM-DD, UNIQUEMENT si la date d'entrée en vigueur
  est explicitement écrite, sinon null. Ne confonds pas avec la date d'adoption
  ou de signature.
- N'invente rien.

EN-TÊTE DU DOCUMENT :
---
${entete}
---
`,
      });

      return object;
    },
  );

  const texte = {
    ...texteBrut,
    source: coerceSelect(texteBrut.source, options.source, "Source"),
  };

  console.log(
    `  Texte : « ${texte.nom} » (code ${code})${texteEnCache ? " (cache)" : ""}`,
  );

  // ---------- Passages ----------
  const passages = decouperParArticle(document);

  console.log(`  ${passages.length} passage(s) à analyser :`);
  for (const passage of passages) {
    console.log(`    - ${passage.label} [${passage.id}]`);
  }

  const contexte: ContextePassage = {
    code,
    texteNom: texte.nom,
    options,
    statutInitial,
  };

  const extraction: Extraction = {
    texte,
    exigences: [],
    controles: [],
    risques: [],
    jurisprudence: [],
    actions: [],
  };

  const analyses = new Map<string, AnalyseImpact>();

  for (let index = 0; index < passages.length; index++) {
    const passage = passages[index];

    console.log(`Passage ${index + 1}/${passages.length} : ${passage.label}`);

    const { resultat, depuisCache } = await traiterPassage(passage, contexte, forcer);

    console.log(
      `  ${resultat.exigences.length} exigence(s), ` +
      `${resultat.controles.length} contrôle(s), ` +
      `${resultat.risques.length} risque(s), ` +
      `${resultat.actions.length} action(s)` +
      `${depuisCache ? " (cache)" : ""}`,
    );

    extraction.exigences.push(...resultat.exigences);
    extraction.controles.push(...resultat.controles);
    extraction.risques.push(...resultat.risques);
    extraction.jurisprudence.push(...resultat.jurisprudence);
    extraction.actions.push(...resultat.actions);

    // Analyse d'impact par lots, passage par passage.
    const analysesPassage = await analyserParLots(
      resultat.exigences,
      organisation,
      forcer,
    );

    for (const analyse of analysesPassage) analyses.set(analyse.exigence, analyse);
  }

  if (extraction.exigences.length === 0) {
    throw new Error(
      "Aucune exigence n'a été extraite du document. " +
      "Vérifie le format du texte et les titres d'articles.",
    );
  }

  // Les doublons éventuels sont retirés AVANT la validation des références.
  dedupeExtraction(extraction);
  validateReferences(extraction);

  console.log("3 bis — Vérification des citations");

  const verifications = verifierCitations(extraction, document);

  // Une exigence sans analyse reçoit une entrée « inconnue » plutôt que d'être absente des matrices.
  for (const item of extraction.exigences) {
    if (!analyses.has(item.id)) {
      console.warn(`⚠️  Pas d'analyse d'impact pour ${item.id} : valeurs par défaut.`);
      analyses.set(item.id, analyseParDefaut(item.id));
    }
  }

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
      citation: P.exigences.citation,
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
      citation: item.citation,
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

  console.log("Module 4 — Proposition de cadre de gouvernance (TOGAF / ITIL / hybride)");

  const gouvernance = await analyserGouvernance(extraction.exigences, organisation, forcer);

  await exporterGouvernance(gouvernance, extraction.exigences);

  console.log(`  ${statutDecision(gouvernance)}`);

  console.log("Génération des matrices GRC (M1 à M5)");

  const cheminMatrices = await exporterMatrices({
    extraction,
    organisation,
    analyses,
    verifications,
    statuts,
    gouvernance,
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