/* ============================================================================
 *  build-pub-cache.mjs  —  regenerate assets/publications-cache.json
 *
 *  Repo   : github.com/LolDadNA/neurolab   (branch: main)
 *  Lives  : assets/build-pub-cache.mjs
 *  Writes : assets/publications-cache.json
 *
 *  Usage (Node 18 or newer, no npm install needed). Run it from anywhere in
 *  the repo — the output path is anchored to this file, not to your shell's
 *  current directory:
 *      node assets/build-pub-cache.mjs
 *
 *  Optional, raises the NCBI rate limit from 3/s to 10/s:
 *      NCBI_API_KEY=xxxxx node assets/build-pub-cache.mjs
 *
 *  Keep the exclusion lists below in sync with assets/pubmed2026.js.
 *  If you would rather not run Node at all: load the live page, open the
 *  browser console, and run  ZhengPubs.downloadCache()  instead.
 * ==========================================================================*/

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This file sits in <repo>/assets/, so the repo root is one level up.
// (It also works unchanged from <repo>/tools/ — any single subfolder.)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CONFIG = {
  esearchURL: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
  esummaryURL: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi",
  db: "pubmed",
  retmax: 1000,
  searchTerms: ['"Zheng, James Q"[Author]', '"James Q Zheng"[Author]'],
  tool: "zhenglab-website",
  email: "neurolab.zheng@gmail.com",
  apiKey: process.env.NCBI_API_KEY || "",
  batchSize: 100,
  outFile: resolve(REPO_ROOT, "assets/publications-cache.json"),

  excludedAffiliations: ["california", "army", "natural resources", "heidelberg"],
  excludedTitleKeywords: ["heart", "heidelberg", "armor certification"],
  excludedAuthors: ["James J Zheng", "Skotak M", "Edwards TD"],
  excludedPMIDs: ["29426024", "29894521", "25267617"],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildURL(base, params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== "" && v != null) qs.append(k, v);
  }
  return `${base}?${qs.toString()}`;
}

function common() {
  const p = { db: CONFIG.db, retmode: "json", tool: CONFIG.tool };
  if (CONFIG.email) p.email = CONFIG.email;
  if (CONFIG.apiKey) p.api_key = CONFIG.apiKey;
  return p;
}

async function getJSON(url, attempt = 0) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": CONFIG.tool } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.trim().startsWith("<")) {
      throw new Error(`NCBI returned XML: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text);
  } catch (err) {
    if (attempt < 2) {
      await sleep(1000 * (attempt + 1));
      return getJSON(url, attempt + 1);
    }
    throw err;
  }
}

async function search(term) {
  const url = buildURL(CONFIG.esearchURL, {
    ...common(),
    retmax: CONFIG.retmax,
    term,
  });
  const data = await getJSON(url);
  const r = data?.esearchresult;
  if (!r) throw new Error("unexpected esearch response");
  if (r.ERROR) throw new Error(`PubMed error: ${r.ERROR}`);
  console.log(`  ${term}`);
  console.log(`    interpreted as : ${r.querytranslation || "(none)"}`);
  console.log(`    hits           : ${r.count}`);
  if (r.errorlist) console.warn("    errorlist    :", JSON.stringify(r.errorlist));
  return Array.isArray(r.idlist) ? r.idlist : [];
}

async function summaries(ids) {
  const records = {};
  for (let i = 0; i < ids.length; i += CONFIG.batchSize) {
    const batch = ids.slice(i, i + CONFIG.batchSize);
    const data = await getJSON(
      buildURL(CONFIG.esummaryURL, { ...common(), id: batch.join(",") }),
    );
    for (const [k, v] of Object.entries(data?.result || {})) {
      if (k !== "uids") records[k] = v;
    }
    console.log(`  summaries ${Math.min(i + batch.length, ids.length)}/${ids.length}`);
    if (i + CONFIG.batchSize < ids.length) await sleep(400);
  }
  return records;
}

function normalise(records) {
  const out = [];
  for (const [pmid, ref] of Object.entries(records)) {
    if (!ref || ref.error) continue;
    if (CONFIG.excludedPMIDs.includes(pmid)) continue;

    const authors = Array.isArray(ref.authors) ? ref.authors : [];
    const affiliations = authors.map((a) => a.affiliation || "").join(" ").toLowerCase();
    const title = (ref.title || "").toLowerCase();
    const names = authors.map((a) => a.name || "");

    if (CONFIG.excludedAffiliations.some((t) => affiliations.includes(t.toLowerCase()))) continue;
    if (CONFIG.excludedTitleKeywords.some((t) => title.includes(t.toLowerCase().trim()))) continue;
    if (
      CONFIG.excludedAuthors.some((bad) =>
        names.some((n) => n.toLowerCase() === bad.toLowerCase()),
      )
    )
      continue;

    out.push({
      pmid,
      title: ref.title || "",
      authors: names.join(", "),
      journal: ref.source || "",
      pubdate: ref.pubdate || "",
      sortdate: ref.sortpubdate || ref.epubdate || ref.pubdate || "",
      volume: ref.volume || "",
      issue: ref.issue || "",
      pages: ref.pages || "",
    });
  }

  out.sort((a, b) => {
    const ya = parseInt(String(a.sortdate).slice(0, 4), 10) || 0;
    const yb = parseInt(String(b.sortdate).slice(0, 4), 10) || 0;
    if (yb !== ya) return yb - ya;
    return parseInt(b.pmid, 10) - parseInt(a.pmid, 10);
  });

  return out;
}

async function main() {
  console.log("Searching PubMed…");
  const ids = [];
  for (const term of CONFIG.searchTerms) {
    try {
      for (const id of await search(term)) if (!ids.includes(id)) ids.push(id);
    } catch (err) {
      console.warn(`  ${term} FAILED: ${err.message}`);
    }
    await sleep(400);
  }

  if (!ids.length) {
    console.error("\nNo PMIDs returned — refusing to overwrite the cache with an empty list.");
    process.exit(1);
  }

  console.log(`\nFetching summaries for ${ids.length} PMIDs…`);
  const publications = normalise(await summaries(ids));

  const payload = {
    generated: new Date().toISOString(),
    queries: CONFIG.searchTerms,
    pmidsFound: ids.length,
    count: publications.length,
    publications,
  };

  await mkdir(dirname(CONFIG.outFile), { recursive: true });
  await writeFile(CONFIG.outFile, JSON.stringify(payload, null, 2), "utf8");
  console.log(`\nWrote ${publications.length} publications to ${CONFIG.outFile}`);
  console.log("Now commit that file:");
  console.log("  git add assets/publications-cache.json");
  console.log('  git commit -m "chore: refresh publication cache"');
  console.log("  git push");
}

main().catch((err) => {
  console.error("\nBuild failed:", err.message);
  process.exit(1);
});
