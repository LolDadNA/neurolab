// --- Configuration ---
const pubmedSearchAPI =
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const pubmedSummaryAPI =
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";
const database = "db=pubmed";
const returnmode = "&retmode=json";
const returnmax = "&retmax=1000"; // Increased retmax for a larger initial fetch
const searchTerm = "&term=James Q Zheng[Author]"; // Simplified search term
// const searchTerm = "&term=James Q Zheng[Author]"; // You can also try this, but 'Zheng JQ' is often more reliable
const htmlPublicationTemplate = `%authors% (%date%) '%title%' <i><b>%journal%</b></i>,%volume% %issue%%pages%PMID:<a href="%data%"target="_blank"> %PMID% </a></br></br>`;

// --- Main function to fetch and display publications ---
async function fetchPubmedRecords() {
  try {
    // Step 1: Search for all publications by author
    const idURL = `${pubmedSearchAPI}?${database}${returnmode}${returnmax}${searchTerm}`;
    const searchResponse = await fetch(idURL);
    const searchData = await searchResponse.json();
    const idList = searchData.esearchresult.idlist;

    if (!idList || idList.length === 0) {
      document.getElementById("demo").innerHTML =
        "No publications found for this author.";
      return;
    }

    const idStringList = idList.join(",");

    // Step 2: Get summary data for all found IDs
    const summaryURL = `${pubmedSummaryAPI}?${database}${returnmode}&id=${idStringList}`;
    const summaryResponse = await fetch(summaryURL);
    const summaryData = await summaryResponse.json();

    // Step 3: Filter and format the references
    const publications = formatAndFilterReferences(
      summaryData,
      htmlPublicationTemplate
    );

    // Display the results
    document.getElementById("demo").innerHTML = publications.join("");
  } catch (error) {
    console.error("An error occurred:", error);
    document.getElementById("demo").innerHTML =
      "Something went wrong fetching the publications.";
  }
}

// --- Function to filter and format the data ---
function formatAndFilterReferences(summary, template) {
  const publicationObjects = [];

  // Define your exclusion criteria in a clear, separate place
  const excludedAffiliations = [
    "california",
    "army",
    "natural resources",
    "heidelberg",
    "U.S. Army",
  ];
  const excludedKeywords = ["heart", "heidelberg", " Armor certification"];
  const excludedAuthors = ["James J Zheng", "Skotak M", "Edwards TD"];
  // Add specific PMIDs to exclude
  const excludedPMIDs = ["29426024", "29894521", "25267617"];

  for (const pmid in summary.result) {
    if (pmid === "uids") continue;

    // --- Filtering Logic ---
    // Exclude the record if its PMID is in the exclusion list
    if (excludedPMIDs.includes(pmid)) {
      continue;
    }

    const ref = summary.result[pmid];

    const affiliations = ref.authors
      .map((a) => a.affiliation)
      .join(" ")
      .toLowerCase();
    const title = ref.title.toLowerCase();

    const hasExcludedAffiliation = excludedAffiliations.some((term) =>
      affiliations.includes(term)
    );
    const hasExcludedKeyword = excludedKeywords.some((term) =>
      title.includes(term)
    );
    const hasOtherAuthor = ref.authors.some(
      (author) => author.name === "James J Zheng"
    );

    if (hasExcludedAffiliation || hasExcludedKeyword || hasOtherAuthor) {
      continue;
    }

    // Store the publication data as an object
    publicationObjects.push({
      pmid: pmid,
      uid: ref.uid,
      title: ref.title,
      authors: ref.authors.map((a) => a.name).join(", "),
      source: ref.source,
      pubdate: ref.pubdate,
      volume: ref.volume,
      issue: ref.issue,
      pages: ref.pages,
    });
  }

  // --- Sorting Logic ---
  // --- Sorting Logic (by year and then PMID, both in descending order) ---
  publicationObjects.sort((a, b) => {
    // First, sort by year in descending order
    const yearA = parseInt(a.pubdate.slice(0, 4), 10) || 0;
    const yearB = parseInt(b.pubdate.slice(0, 4), 10) || 0;

    if (yearB !== yearA) {
      return yearB - yearA;
    }

    // If years are the same, sort by PMID in descending order
    const pmidA = parseInt(a.pmid, 10);
    const pmidB = parseInt(b.pmid, 10);

    return pmidB - pmidA;
  });

  // --- Formatting Logic ---
  // Now, format the sorted array into HTML
  return publicationObjects.map((ref) => {
    let publication = template.replace(
      "%data%",
      `http://www.ncbi.nlm.nih.gov/pubmed/${ref.pmid}`
    );
    publication = publication.replace("%PMID%", ref.uid);
    publication = publication.replace("%authors%", ref.authors);
    publication = publication.replace("%title%", ref.title);
    publication = publication.replace("%journal%", ref.source);

    if (ref.volume) {
      const date = ref.pubdate ? ref.pubdate.slice(0, 4) : "";
      publication = publication.replace("%date%", date);
      publication = publication.replace("%volume%", ` ${ref.volume}`);
      publication = publication.replace(
        "%issue%",
        ref.issue ? `(${ref.issue})` : ""
      );
      publication = publication.replace("%pages%", `: ${ref.pages}. `);
    } else {
      publication = publication.replace("%volume%", " In Press");
      publication = publication.replace("%issue%", ".");
      publication = publication.replace("%pages%", "");
      publication = publication.replace("%date%", "");
    }
    return publication;
  });
}
// Start the process
document.addEventListener("DOMContentLoaded", () => {
  fetchPubmedRecords();
});
