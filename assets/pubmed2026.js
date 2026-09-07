/* ============================================================================
 *  pubmed2026.js  —  Zheng lab publication list
 *  Repo: github.com/LolDadNA/neurolab
 *
 *  HOW THIS WORKS
 *    Normal visit : reads assets/publications-cache.json and renders it.
 *                   PubMed is never contacted. One small static file, done.
 *    Snapshot bad : if that file is missing, empty or unreadable, it falls
 *                   back to a live PubMed query so the page is never blank.
 *    ?refresh=1   : forces a live PubMed query, ignoring the snapshot.
 *                   e.g. publications.html?refresh=1
 *
 *    The snapshot is regenerated weekly by
 *    .github/workflows/refresh-publications.yml, or by hand with
 *    node tools/build-pub-cache.mjs
 *
 *  CONSOLE HELPERS (F12 -> Console)
 *    ZhengPubs.refresh()       -> live query now, without reloading
 *    ZhengPubs.downloadCache() -> save the current list as publications-cache.json
 *    ZhengPubs.diagnose()      -> show what PubMed actually returns for each term
 * ==========================================================================*/

(function () {
  "use strict";

  // --------------------------------------------------------------------
  // CONFIGURATION
  // --------------------------------------------------------------------
  const CONFIG = {
    targetId: "demo", // the <p id="demo"> in publications.html

    cacheFileURL: "assets/publications-cache.json",

    // Console-only warning if the snapshot has not been rebuilt in this long.
    // Visitors never see this; it is a nudge for you.
    staleAfterDays: 21,

    // Header bar above the list: [Updated 7 Sep 2026]  [Refresh]
    showHeader: true,

    // Refresh is greyed out while the snapshot is younger than this.
    // Set to 0 to always allow it. ?refresh=1 and ZhengPubs.refresh()
    // ignore the cooldown.
    refreshCooldownHours: 24,

    // --- live-query settings (used only on fallback or ?refresh=1) ---
    esearchURL: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
    esummaryURL: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi",
    db: "pubmed",
    retmax: 1000,

    // Results from all terms are merged and de-duplicated, so one term
    // failing cannot empty the page. Do NOT pre-encode these.
    searchTerms: [
      '"Zheng, James Q"[Author]', // current PubMed full-name index format
      '"James Q Zheng"[Author]', // legacy format; same person, harmless at 0 hits
    ],

    tool: "zhenglab-website",
    email: "neurolab.zheng@gmail.com",
    apiKey: "", // optional; raises the rate limit from 3/s to 10/s

    summaryBatchSize: 100,
    requestTimeoutMs: 15000,
    retries: 2,

    // --- exclusion rules (keep in sync with tools/build-pub-cache.mjs) ---
    excludedAffiliations: [
      "california",
      "army",
      "natural resources",
      "heidelberg",
    ],
    excludedTitleKeywords: ["heart", "heidelberg", "armor certification"],
    excludedAuthors: ["James J Zheng", "Skotak M", "Edwards TD"],
    excludedPMIDs: ["29426024", "29894521", "25267617"],
  };

  const TEMPLATE =
    "%authors% (%date%) '%title%' <i><b>%journal%</b></i>,%volume% " +
    "%issue%%pages%PMID:<a href=\"%url%\" target=\"_blank\" rel=\"noopener\"> %pmid% </a></br></br>";

  // --------------------------------------------------------------------
  // Utilities
  // --------------------------------------------------------------------
  const target = () => document.getElementById(CONFIG.targetId);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function buildURL(base, params) {
    const qs = new URLSearchParams();
    Object.keys(params).forEach((k) => {
      if (params[k] !== "" && params[k] != null) qs.append(k, params[k]);
    });
    return base + "?" + qs.toString();
  }

  function commonParams() {
    const p = { db: CONFIG.db, retmode: "json", tool: CONFIG.tool };
    if (CONFIG.email) p.email = CONFIG.email;
    if (CONFIG.apiKey) p.api_key = CONFIG.apiKey;
    return p;
  }

  function prettyDate(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "an unknown date" : d.toLocaleDateString();
  }

  // "7 Sep 2026" — compact, and reads the same in every locale
  function formatShort(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "unknown date";
    return d.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  function hoursSince(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return Infinity;
    return (Date.now() - d.getTime()) / 3600000;
  }

  function daysSince(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return Infinity;
    return (Date.now() - d.getTime()) / 86400000;
  }

  async function fetchJSON(url, options) {
    let lastError;
    for (let attempt = 0; attempt <= CONFIG.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        CONFIG.requestTimeoutMs,
      );
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          ...(options || {}),
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error("HTTP " + res.status + " from NCBI");
        const text = await res.text();
        // NCBI returns XML, not JSON, when it rejects a request outright.
        if (text.trim().startsWith("<")) {
          throw new Error(
            "NCBI returned XML instead of JSON: " + text.slice(0, 200),
          );
        }
        return JSON.parse(text);
      } catch (err) {
        clearTimeout(timer);
        lastError = err;
        if (attempt < CONFIG.retries) await sleep(800 * (attempt + 1));
      }
    }
    throw lastError;
  }

  // --------------------------------------------------------------------
  // Rendering
  // --------------------------------------------------------------------
  function renderOne(pub) {
    const year = pub.pubdate ? pub.pubdate.slice(0, 4) : "";
    const inPress = !pub.volume;

    const fields = {
      authors: pub.authors,
      date: year,
      title: pub.title,
      journal: pub.journal,
      volume: inPress ? " In Press" : " " + pub.volume,
      issue: inPress ? "." : pub.issue ? "(" + pub.issue + ")" : "",
      pages: inPress ? "" : ": " + pub.pages + ". ",
      pmid: pub.pmid,
      url: "https://pubmed.ncbi.nlm.nih.gov/" + pub.pmid + "/",
    };

    // Function replacer avoids the "$&" pitfall of String.replace.
    return TEMPLATE.replace(/%(\w+)%/g, (m, key) =>
      Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : m,
    );
  }

  function banner(text) {
    return (
      '<span style="display:block;margin:0 0 1.4em 0;padding:.5em .8em;' +
      'border-left:3px solid currentColor;opacity:.7;font-size:.9em;">' +
      text +
      "</span>"
    );
  }

  // Inline-level only: this is injected into a <p>, so no <div> allowed.
  function headerHTML(payload) {
    if (!CONFIG.showHeader) return "";

    const stamp = payload.live
      ? "Updated just now"
      : "Updated " + formatShort(payload.generated);

    const age = hoursSince(payload.generated);
    const onCooldown = age < CONFIG.refreshCooldownHours;

    const control = onCooldown
      ? '<span id="pub-refresh-off" title="This list was updated less than ' +
        CONFIG.refreshCooldownHours +
        ' hours ago." style="opacity:.5;cursor:default;">Refresh</span>'
      : '<a href="#" id="pub-refresh" role="button" ' +
        'title="Fetch the current list from PubMed" ' +
        'style="cursor:pointer;text-decoration:underline;">Refresh</a>';

    return (
      '<span style="display:flex;justify-content:flex-end;align-items:baseline;' +
      'gap:.8em;margin:0 0 1.2em 0;font-size:.85em;opacity:.65;">' +
      '<span id="pub-stamp">' +
      stamp +
      "</span>" +
      control +
      "</span>"
    );
  }

  // payload = { publications, generated, live? }
  function render(payload, notice) {
    const el = target();
    if (!el) return;
    el.innerHTML =
      headerHTML(payload) +
      (notice ? banner(notice) : "") +
      payload.publications.map(renderOne).join("");
  }

  // --------------------------------------------------------------------
  // The snapshot — this is the normal path
  // --------------------------------------------------------------------
  async function readSnapshot() {
    try {
      // no-cache forces a revalidation, so a fresh commit shows up right away.
      // The server almost always answers 304, so this costs next to nothing.
      const res = await fetch(CONFIG.cacheFileURL, { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (!Array.isArray(data.publications) || !data.publications.length) {
        throw new Error("snapshot contains no publications");
      }
      return data;
    } catch (err) {
      console.warn("[publications] snapshot unusable:", err.message || err);
      return null;
    }
  }

  // --------------------------------------------------------------------
  // Live PubMed query — fallback and ?refresh=1 only
  // --------------------------------------------------------------------
  async function searchPMIDs(term) {
    const url = buildURL(CONFIG.esearchURL, {
      ...commonParams(),
      retmax: CONFIG.retmax,
      term: term,
    });
    const data = await fetchJSON(url);
    const r = data && data.esearchresult;
    if (!r) throw new Error("Unexpected esearch response shape");
    if (r.ERROR) throw new Error("PubMed error: " + r.ERROR);

    return {
      term: term,
      url: url,
      ids: Array.isArray(r.idlist) ? r.idlist : [],
      count: parseInt(r.count, 10) || 0,
      translation: r.querytranslation || "",
      errors: r.errorlist || null,
      warnings: r.warninglist || null,
    };
  }

  async function fetchSummaries(ids) {
    const records = {};
    for (let i = 0; i < ids.length; i += CONFIG.summaryBatchSize) {
      const batch = ids.slice(i, i + CONFIG.summaryBatchSize);
      const data = await fetchJSON(
        buildURL(CONFIG.esummaryURL, {
          ...commonParams(),
          id: batch.join(","),
        }),
      );
      const result = data && data.result;
      if (!result) throw new Error("Unexpected esummary response shape");
      Object.keys(result).forEach((k) => {
        if (k !== "uids") records[k] = result[k];
      });
      if (i + CONFIG.summaryBatchSize < ids.length) await sleep(400);
    }
    return records;
  }

  function normalise(records) {
    const out = [];

    Object.keys(records).forEach((pmid) => {
      const ref = records[pmid];
      if (!ref || ref.error) return;
      if (CONFIG.excludedPMIDs.indexOf(pmid) !== -1) return;

      const authors = Array.isArray(ref.authors) ? ref.authors : [];
      const affiliations = authors
        .map((a) => a.affiliation || "")
        .join(" ")
        .toLowerCase();
      const title = (ref.title || "").toLowerCase();
      const names = authors.map((a) => a.name || "");

      const badAffiliation = CONFIG.excludedAffiliations.some((t) =>
        affiliations.includes(t.toLowerCase()),
      );
      const badTitle = CONFIG.excludedTitleKeywords.some((t) =>
        title.includes(t.toLowerCase().trim()),
      );
      const badAuthor = CONFIG.excludedAuthors.some((bad) =>
        names.some((n) => n.toLowerCase() === bad.toLowerCase()),
      );
      if (badAffiliation || badTitle || badAuthor) return;

      out.push({
        pmid: pmid,
        title: ref.title || "",
        authors: names.join(", "),
        journal: ref.source || "",
        pubdate: ref.pubdate || "",
        sortdate: ref.sortpubdate || ref.epubdate || ref.pubdate || "",
        volume: ref.volume || "",
        issue: ref.issue || "",
        pages: ref.pages || "",
      });
    });

    out.sort((a, b) => {
      const ya = parseInt(String(a.sortdate).slice(0, 4), 10) || 0;
      const yb = parseInt(String(b.sortdate).slice(0, 4), 10) || 0;
      if (yb !== ya) return yb - ya;
      return parseInt(b.pmid, 10) - parseInt(a.pmid, 10);
    });

    return out;
  }

  async function fetchLive() {
    // A term that errors or returns nothing must not take down the others.
    const searches = [];
    for (const term of CONFIG.searchTerms) {
      try {
        searches.push(await searchPMIDs(term));
      } catch (err) {
        console.warn("[publications] term failed: " + term, err);
        searches.push({ term: term, ids: [], count: 0, failed: String(err) });
      }
      await sleep(400);
    }

    const ids = [];
    const seen = Object.create(null);
    searches.forEach((s) =>
      s.ids.forEach((id) => {
        if (!seen[id]) {
          seen[id] = true;
          ids.push(id);
        }
      }),
    );

    if (!ids.length) {
      const detail = searches
        .map((s) => s.term + " -> " + (s.failed || s.count + " hits"))
        .join("; ");
      throw new Error("PubMed returned zero records (" + detail + ")");
    }

    const publications = normalise(await fetchSummaries(ids));

    return {
      generated: new Date().toISOString(),
      queries: CONFIG.searchTerms,
      pmidsFound: ids.length,
      count: publications.length,
      publications: publications,
    };
  }

  // --------------------------------------------------------------------
  // Orchestration
  // --------------------------------------------------------------------
  let latest = null;

  function noPublicationsMessage() {
    return (
      "Publications are temporarily unavailable. Please see " +
      '<a href="https://pubmed.ncbi.nlm.nih.gov/?term=%22Zheng%2C+James+Q%22%5BAuthor%5D" ' +
      "target=\"_blank\" rel=\"noopener\">this author's PubMed listing</a>."
    );
  }

  async function runLive(noticeOnSuccess) {
    const live = await fetchLive();
    live.live = true;
    latest = live;
    render(live, noticeOnSuccess);
    console.info(
      "[publications] live from PubMed: " +
        live.count +
        " records (" +
        live.pmidsFound +
        " PMIDs before filtering). " +
        "Run ZhengPubs.downloadCache() to save this as the new snapshot.",
    );
    return live;
  }

  let refreshing = false;

  async function onContainerClick(e) {
    const link =
      e.target && e.target.closest ? e.target.closest("#pub-refresh") : null;
    if (!link) return;
    e.preventDefault();
    if (refreshing) return;

    refreshing = true;
    link.textContent = "Refreshing…";
    const previous = latest;
    try {
      await runLive(null);
    } catch (err) {
      console.error("[publications] refresh failed:", err);
      if (previous && previous.publications.length) {
        render(
          previous,
          "PubMed could not be reached — still showing the saved list from " +
            formatShort(previous.generated) +
            ".",
        );
      }
    } finally {
      refreshing = false;
    }
  }

  async function main() {
    const el = target();
    if (!el) return;
    el.innerHTML = "<i>Loading publications…</i>";
    el.addEventListener("click", onContainerClick);

    const forceLive = new URLSearchParams(location.search).has("refresh");

    // --- normal path: static snapshot, no PubMed traffic ---
    if (!forceLive) {
      const snap = await readSnapshot();
      if (snap) {
        latest = snap;
        const age = daysSince(snap.generated);
        render(snap, null);
        console.info(
          "[publications] from snapshot: " +
            snap.publications.length +
            " records, generated " +
            prettyDate(snap.generated),
        );
        if (age > CONFIG.staleAfterDays) {
          console.warn(
            "[publications] snapshot is " +
              Math.round(age) +
              " days old. Re-run the Actions workflow, or load this page " +
              "with ?refresh=1 and use ZhengPubs.downloadCache().",
          );
        }
        return; // <- PubMed is never contacted on a normal visit
      }
      console.warn(
        "[publications] no usable snapshot; falling back to a live query.",
      );
    }

    // --- fallback path, or an explicit ?refresh=1 ---
    try {
      await runLive(
        forceLive
          ? "Live from PubMed (?refresh=1). This is not what visitors see."
          : null,
      );
    } catch (err) {
      console.error("[publications] live fetch failed:", err);
      const snap = latest || (await readSnapshot());
      if (snap && snap.publications.length) {
        latest = snap;
        render(
          snap,
          "PubMed could not be reached — showing the saved list from " +
            formatShort(snap.generated) +
            ".",
        );
      } else {
        el.innerHTML = noPublicationsMessage();
      }
    }
  }

  // --------------------------------------------------------------------
  // Console helpers
  // --------------------------------------------------------------------
  window.ZhengPubs = {
    config: CONFIG,
    get data() {
      return latest;
    },

    // Live query without reloading the page.
    refresh() {
      return runLive("Live from PubMed. This is not what visitors see.").catch(
        (e) => console.error(e),
      );
    },

    async diagnose() {
      for (const term of CONFIG.searchTerms) {
        console.group("term: " + term);
        try {
          const r = await searchPMIDs(term);
          console.log("request URL      :", r.url);
          console.log("total count      :", r.count);
          console.log("PMIDs returned   :", r.ids.length);
          console.log("PubMed read it as:", r.translation);
          if (r.errors) console.warn("errorlist  :", r.errors);
          if (r.warnings) console.warn("warninglist:", r.warnings);
        } catch (e) {
          console.error(e);
        }
        console.groupEnd();
      }
    },

    downloadCache() {
      if (!latest || !latest.publications.length) {
        console.warn(
          "Nothing to save. Run ZhengPubs.refresh() first so the list comes " +
            "from PubMed rather than from the existing snapshot.",
        );
        return;
      }
      const blob = new Blob([JSON.stringify(latest, null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "publications-cache.json";
      a.click();
      URL.revokeObjectURL(a.href);
      console.info("Saved. Commit it to assets/publications-cache.json.");
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
  } else {
    main();
  }
})();
