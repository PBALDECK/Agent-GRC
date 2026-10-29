/**
 * Serveur MCP « GRC » — expose la base de veille GRC (Notion) à n'importe quel client MCP
 * (Claude Desktop, Claude Code, Cursor...).
 *
 * Lancer depuis la racine du projet :  npm run mcp   (transport stdio)
 *
 * Règle de conception : l'IA consulte et PROPOSE ; seule une décision explicitement donnée par un humain
 * nommé (paramètre `relecteur`) modifie le statut d'une exigence. Chaque décision est tracée dans
 * data/journal_validation.jsonl, comme dans le cockpit.
 *
 * ATTENTION : en stdio, stdout est réservé au protocole. Tous les logs passent par console.error.
 */

import { config } from "dotenv";
import { Client } from "@notionhq/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

config({ path: resolve(process.cwd(), ".env"), quiet: true });

if (!process.env.NOTION_API_KEY) {
  console.error("NOTION_API_KEY est absent du fichier .env (lance le serveur depuis la racine du projet).");
  process.exit(1);
}

const notion = new Client({ auth: process.env.NOTION_API_KEY, notionVersion: "2025-09-03" });

// Mêmes bases que src/agent.ts
const DB_EXIGENCES = process.env.NOTION_DB_EXIGENCES ?? "40669590303580adb9c2dce8aa09e4f0";

const FICHIER_EXIGENCES = resolve("data", "exigences.json");
const FICHIER_GOUVERNANCE = resolve("data", "gouvernance.json");
const FICHIER_DECISION = resolve("data", "decision_gouvernance.json");
const FICHIER_JOURNAL = resolve("data", "journal_validation.jsonl");

// ==================================================
// Accès Notion
// ==================================================

const norm = (v: string) =>
  v.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

type Schema = {
  dataSourceId: string;
  props: Record<string, any>;
  titre: string;
  statut: string;
  article?: string;
  description?: string;
  criticite?: string;
  citation?: string;
  echeance?: string;
  sanction?: string;
  verifiee?: string;
  confiance?: string;
  options: { aValider: string; valide: string; rejete: string };
};

let schemaCache: Schema | null = null;

async function schema(): Promise<Schema> {
  if (schemaCache) return schemaCache;

  const db: any = await notion.databases.retrieve({ database_id: DB_EXIGENCES });
  const dataSourceId = db.data_sources?.[0]?.id;
  if (!dataSourceId) throw new Error("Aucune source de données pour la base des exigences (accès de l'intégration ?).");

  const ds: any = await notion.dataSources.retrieve({ data_source_id: dataSourceId });
  const props: Record<string, any> = ds.properties;

  const trouver = (noms: string[], type?: string) =>
    Object.keys(props).find(
      n => noms.some(c => norm(c) === norm(n)) && (!type || props[n].type === type),
    );

  const titre = Object.keys(props).find(n => props[n].type === "title");
  const statut = trouver(["Statut"], "select");
  if (!titre || !statut) throw new Error("Propriétés « ID Exigence » (titre) ou « Statut » (select) introuvables.");

  const opts: string[] = (props[statut].select?.options ?? []).map((o: any) => o.name);
  const option = (debut: string, defaut: string) => opts.find(o => norm(o).startsWith(debut)) ?? defaut;

  schemaCache = {
    dataSourceId,
    props,
    titre,
    statut,
    article: trouver(["Article"], "select"),
    description: trouver(["Description"], "rich_text"),
    criticite: trouver(["Criticité", "Criticite"], "select"),
    citation: trouver(["Citation"], "rich_text"),
    echeance: trouver(["Échéance", "Echeance"], "rich_text"),
    sanction: trouver(["Sanction"], "rich_text"),
    verifiee: trouver(["Citation vérifiée", "Citation verifiee"], "checkbox"),
    confiance: trouver(["Confiance"], "number"),
    options: {
      aValider: option("avalid", "À valider"),
      valide: option("valid", "Validée"),
      rejete: option("rej", "Rejetée"),
    },
  };
  return schemaCache;
}

function lire(page: any, nom?: string): any {
  if (!nom) return null;
  const p = page.properties?.[nom];
  if (!p) return null;
  switch (p.type) {
    case "title":
    case "rich_text":
      return (p[p.type] as any[]).map(x => x.plain_text).join("");
    case "select":
      return p.select?.name ?? "";
    default:
      return p[p.type] ?? null;
  }
}

async function toutesLesExigences(): Promise<any[]> {
  const s = await schema();
  const pages: any[] = [];
  let curseur: string | undefined;
  do {
    const rep: any = await notion.dataSources.query({
      data_source_id: s.dataSourceId,
      start_cursor: curseur,
      page_size: 100,
    });
    pages.push(...rep.results);
    curseur = rep.has_more ? rep.next_cursor : undefined;
  } while (curseur);
  return pages;
}

async function trouverPage(id: string): Promise<any | null> {
  const s = await schema();
  const rep: any = await notion.dataSources.query({
    data_source_id: s.dataSourceId,
    filter: { property: s.titre, title: { equals: id } },
    page_size: 1,
  });
  return rep.results[0] ?? null;
}

function resume(page: any, s: Schema) {
  return {
    id: lire(page, s.titre),
    article: lire(page, s.article),
    criticite: lire(page, s.criticite),
    statut: lire(page, s.statut),
    confiance: lire(page, s.confiance),
    citationVerifiee: lire(page, s.verifiee),
  };
}

async function lireJson(chemin: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(chemin, "utf8"));
  } catch {
    return null;
  }
}

const texte = (donnees: unknown) => ({
  content: [{ type: "text" as const, text: typeof donnees === "string" ? donnees : JSON.stringify(donnees, null, 2) }],
});

const erreur = (message: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: message }],
});

// ==================================================
// Serveur MCP
// ==================================================

const serveur = new McpServer({ name: "grc-veille", version: "1.0.0" });

serveur.registerTool(
  "lister_exigences",
  {
    description:
      "Liste les exigences réglementaires de la base Notion (id, article, criticité, statut, confiance, citation vérifiée). " +
      "Filtre possible sur le statut : « a_valider », « validee », « rejetee ».",
    inputSchema: {
      statut: z.enum(["a_valider", "validee", "rejetee"]).optional(),
      limite: z.number().int().min(1).max(100).default(30),
    },
  },
  async ({ statut, limite }) => {
    const s = await schema();
    const pages = await toutesLesExigences();
    const cible = statut && { a_valider: s.options.aValider, validee: s.options.valide, rejetee: s.options.rejete }[statut];

    const lignes = pages
      .map(p => resume(p, s))
      .filter(r => !cible || norm(r.statut ?? "") === norm(cible))
      // les moins fiables d'abord : c'est ce qu'un relecteur doit voir en premier
      .sort((a, b) => (a.citationVerifiee === b.citationVerifiee ? 0 : a.citationVerifiee ? 1 : -1) || (a.confiance ?? 0) - (b.confiance ?? 0))
      .slice(0, limite);

    return texte({ total: lignes.length, exigences: lignes });
  },
);

serveur.registerTool(
  "consulter_exigence",
  {
    description:
      "Détail d'une exigence : description, citation, sanction, échéance, qualité (citation vérifiée, confiance) " +
      "et analyse d'impact produite par l'agent.",
    inputSchema: { id: z.string().describe("ID de l'exigence, ex. EX-DORA-28-P1-01") },
  },
  async ({ id }) => {
    const s = await schema();
    const page = await trouverPage(id);
    if (!page) return erreur(`Exigence introuvable : ${id}`);

    const local = ((await lireJson(FICHIER_EXIGENCES))?.exigences ?? []).find((e: any) => e.id === id);

    return texte({
      ...resume(page, s),
      description: lire(page, s.description),
      citation: lire(page, s.citation),
      echeance: lire(page, s.echeance),
      sanction: lire(page, s.sanction),
      analyseImpact: local?.analyse ?? null,
      lienNotion: page.url,
    });
  },
);

serveur.registerTool(
  "decider_exigence",
  {
    description:
      "Enregistre la décision d'un HUMAIN sur une exigence (valider ou rejeter) dans Notion. " +
      "À n'appeler que si l'utilisateur a explicitement donné sa décision et son nom : ne jamais décider à sa place. " +
      "Un rejet exige un commentaire.",
    inputSchema: {
      id: z.string(),
      decision: z.enum(["valider", "rejeter"]),
      relecteur: z.string().min(2).describe("Nom de la personne qui prend la décision"),
      commentaire: z.string().default(""),
    },
  },
  async ({ id, decision, relecteur, commentaire }) => {
    if (decision === "rejeter" && !commentaire.trim()) return erreur("Un rejet doit être motivé : commentaire requis.");

    const s = await schema();
    const page = await trouverPage(id);
    if (!page) return erreur(`Exigence introuvable : ${id}`);

    const avant = lire(page, s.statut);
    const apres = decision === "valider" ? s.options.valide : s.options.rejete;

    await notion.pages.update({
      page_id: page.id,
      properties: { [s.statut]: { select: { name: apres } } },
    });

    await mkdir(resolve("data"), { recursive: true });
    await appendFile(
      FICHIER_JOURNAL,
      JSON.stringify({
        horodatage: new Date().toISOString().slice(0, 19),
        exigence: id,
        page_id: page.id,
        relecteur,
        decision: decision === "valider" ? "valide" : "rejete",
        commentaire: commentaire.trim(),
        source: "mcp",
        avant: { statut: avant },
        apres: { statut: apres },
      }) + "\n",
      "utf8",
    );

    return texte(`${id} : « ${avant} » → « ${apres} » par ${relecteur} (tracé dans le journal).`);
  },
);

serveur.registerTool(
  "proposition_gouvernance",
  {
    description:
      "Proposition de l'agent pour le cadre de gouvernance (TOGAF, ITIL ou hybride) et décision humaine éventuelle. " +
      "Lecture seule : le choix du cadre reste une décision humaine.",
    inputSchema: {},
  },
  async () => {
    const g = await lireJson(FICHIER_GOUVERNANCE);
    if (!g) return erreur("Aucune proposition : lance d'abord `npm run agent`.");
    const decision = await lireJson(FICHIER_DECISION);
    return texte({
      propositionIA: g.propositionIA,
      repartitionCalculee: g.repartitionCalculee,
      decisionHumaine: decision?.decisionHumaine ?? "en attente de décision humaine",
      statut: g.statut,
    });
  },
);

serveur.registerTool(
  "synthese_pilotage",
  {
    description: "Indicateurs de pilotage : nombre d'exigences par statut et par criticité.",
    inputSchema: {},
  },
  async () => {
    const s = await schema();
    const resumes = (await toutesLesExigences()).map(p => resume(p, s));
    const compter = (cle: "statut" | "criticite") =>
      resumes.reduce<Record<string, number>>((acc, r) => {
        const k = r[cle] || "—";
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {});
    return texte({
      total: resumes.length,
      parStatut: compter("statut"),
      parCriticite: compter("criticite"),
      citationsNonVerifiees: resumes.filter(r => r.citationVerifiee === false).length,
    });
  },
);

async function demarrer(): Promise<void> {
  await serveur.connect(new StdioServerTransport());
  console.error("Serveur MCP GRC démarré (stdio).");
}

demarrer().catch(e => {
  console.error("Échec du démarrage du serveur MCP :", e?.message ?? e);
  process.exit(1);
});