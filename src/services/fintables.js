// Fintables (fintables.com) integration — best effort.
//
// Unlike TEFAS's BindHistoryInfo/BindHistoryAllocation endpoints, Fintables
// does not publish a documented public API, so this scrapes the rendered
// fund page for its "top holdings" (which BIST stocks the fund actually
// holds — TEFAS's own allocation endpoint only gives asset *classes* like
// "stocks 62%", not individual tickers).
//
// Because this depends on Fintables' page markup, it is written
// defensively: every selector strategy is tried in turn, and if none of
// them find a recognizable holdings table the function returns
// `{ ok: false }` instead of throwing, so the UI can show "unavailable"
// rather than break. If Fintables changes their markup, update
// `HOLDING_ROW_SELECTORS` below to match the new page.
const cheerio = require("cheerio");

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; market-fund-management/1.0)",
  Accept: "text/html",
};

const REQUEST_TIMEOUT_MS = 15 * 1000;

// Matches a BIST equity ticker: 3-6 uppercase letters, standing alone.
const TICKER_RE = /^[A-Z]{3,6}$/;
// Matches a percentage like "12,34%" or "12.34%".
const PERCENT_RE = /(\d+(?:[.,]\d+)?)\s*%/;

function parsePercent(text) {
  const match = text.match(PERCENT_RE);
  if (!match) return null;
  return Number(match[1].replace(",", "."));
}

/**
 * Best-effort scrape of a fund's top equity holdings from its Fintables page.
 * @returns {Promise<{ ok: boolean, url: string, holdings: Array<{ticker: string, percent: number}>, error?: string }>}
 */
async function fetchFundHoldings(fundCode) {
  const url = `https://fintables.com/fonlar/${encodeURIComponent(fundCode)}`;
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    const holdings = [];

    // Strategy: scan every table row / list item on the page for a short
    // uppercase ticker cell paired with a percentage cell. This avoids
    // depending on a specific CSS class name, which is the part of the page
    // most likely to change.
    $("tr, li").each((_, el) => {
      const cells = $(el)
        .find("td, span, div")
        .map((__, c) => $(c).text().trim())
        .get()
        .filter(Boolean);

      const ticker = cells.find((c) => TICKER_RE.test(c));
      const percentCell = cells.find((c) => PERCENT_RE.test(c));
      if (!ticker || !percentCell) return;

      const percent = parsePercent(percentCell);
      if (percent == null || percent <= 0 || percent > 100) return;

      if (!holdings.some((h) => h.ticker === ticker)) {
        holdings.push({ ticker, percent });
      }
    });

    holdings.sort((a, b) => b.percent - a.percent);

    if (holdings.length === 0) {
      return { ok: false, url, holdings: [], error: "No recognizable holdings table found on the page." };
    }

    return { ok: true, url, holdings: holdings.slice(0, 20) };
  } catch (err) {
    return { ok: false, url, holdings: [], error: err.message };
  }
}

module.exports = { fetchFundHoldings };
