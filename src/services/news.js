// Aggregates headlines from a curated list of trusted financial news
// outlets via their public RSS feeds — no API key, no scraping fragile
// HTML, just standard RSS/Atom XML.
//
// Feeds skew Turkish since the portfolio this app is built for holds
// TEFAS funds, plus one international market-news source. Each feed is
// fetched and parsed independently: if one is down or has changed its
// feed URL, it's dropped silently from the merged list rather than
// failing the whole fetch (mirrors how fintables.js degrades).
//
// RSS feed URLs occasionally move; if a source stops showing up, check
// its current feed URL and update FEEDS below.
const { XMLParser } = require("fast-xml-parser");

const REQUEST_TIMEOUT_MS = 15 * 1000;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; market-fund-management/1.0)",
  Accept: "application/rss+xml, application/xml, text/xml, */*",
};

const FEEDS = [
  { source: "Bloomberg HT", url: "https://www.bloomberght.com/rss" },
  { source: "Dünya Gazetesi", url: "https://www.dunya.com/rss" },
  { source: "Anadolu Ajansı — Ekonomi", url: "https://www.aa.com.tr/tr/rss/default?cat=ekonomi" },
  { source: "Investing.com", url: "https://www.investing.com/rss/news_25.rss" },
];

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function stripHtml(text) {
  if (typeof text !== "string") return "";
  return text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function extractLink(item) {
  // RSS 2.0: <link>https://...</link>. Atom: <link href="https://..."/>.
  if (typeof item.link === "string") return item.link;
  if (item.link && item.link["@_href"]) return item.link["@_href"];
  if (Array.isArray(item.link)) {
    const withHref = item.link.find((l) => l && l["@_href"]);
    return withHref ? withHref["@_href"] : null;
  }
  return null;
}

async function fetchFeed({ source, url }) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const parsed = parser.parse(xml);

    // Support both RSS (rss.channel.item) and Atom (feed.entry).
    const items = parsed.rss?.channel?.item ?? parsed.feed?.entry ?? [];

    return asArray(items)
      .map((item) => {
        const title = stripHtml(item.title);
        const link = extractLink(item);
        const rawDate = item.pubDate || item.published || item.updated || null;
        const date = rawDate ? new Date(rawDate) : null;
        const summary = stripHtml(item.description || item.summary || "");
        return {
          source,
          title,
          link,
          publishedAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
          summary: summary.slice(0, 300),
        };
      })
      .filter((item) => item.title && item.link);
  } catch (err) {
    return { source, url, error: err.message, items: [] };
  }
}

/**
 * Fetch and merge headlines from every configured feed.
 * @returns {Promise<{ articles: Array, sourceErrors: Array<{source:string, error:string}> }>}
 */
async function fetchNews({ perFeedLimit = 10 } = {}) {
  const results = await Promise.all(FEEDS.map(fetchFeed));

  const articles = [];
  const sourceErrors = [];
  for (const result of results) {
    if (Array.isArray(result)) {
      articles.push(...result.slice(0, perFeedLimit));
    } else {
      sourceErrors.push({ source: result.source, error: result.error });
    }
  }

  articles.sort((a, b) => {
    if (!a.publishedAt) return 1;
    if (!b.publishedAt) return -1;
    return new Date(b.publishedAt) - new Date(a.publishedAt);
  });

  return { articles, sourceErrors };
}

module.exports = { fetchNews, FEEDS };
