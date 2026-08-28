// TEFAS (Turkey Electronic Fund Trading Platform) integration.
//
// TEFAS publishes fund NAV history and portfolio-allocation history through
// two documented, unauthenticated JSON endpoints that power the charts on
// tefas.gov.tr itself:
//   POST /api/DB/BindHistoryInfo       -> daily price (NAV) history
//   POST /api/DB/BindHistoryAllocation -> daily asset-allocation breakdown
//
// TEFAS updates a fund's NAV once per trading day (after markets close), so
// "real time" here means "as fresh as the source publishes", refreshed on an
// interval rather than streamed tick-by-tick.
//
// The API sits behind an ASP.NET session: hitting BindHistoryInfo cold
// (no cookie, as if you typed the endpoint directly) gets rejected. A real
// browser first loads the historical-data page, which sets a session
// cookie, and only then calls the API. This module reproduces that by
// grabbing the cookie once and reusing it, refreshed periodically.

const BASE_URL = "https://www.tefas.gov.tr";
const SESSION_PAGE = "/TarihselVeriler.aspx";
const SESSION_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let session = { cookie: null, fetchedAt: 0 };

async function getSessionCookie() {
  if (session.cookie && Date.now() - session.fetchedAt < SESSION_TTL_MS) {
    return session.cookie;
  }
  const res = await fetch(`${BASE_URL}${SESSION_PAGE}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  session = { cookie, fetchedAt: Date.now() };
  return cookie;
}

function formatDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

// TEFAS timestamps arrive as ASP.NET's "/Date(1699999999000)/" wire format.
function parseNetDate(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/\/Date\((\d+)\)\//);
  if (!match) return null;
  return new Date(Number(match[1]));
}

async function postForm(path, params, { retried = false } = {}) {
  const cookie = await getSessionCookie();
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      Origin: BASE_URL,
      Referer: `${BASE_URL}${SESSION_PAGE}`,
      "User-Agent": USER_AGENT,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    // A stale/rejected session cookie is the most common cause of a
    // non-2xx here; force a fresh one and retry exactly once before
    // giving up, so a transient session expiry doesn't surface as a
    // permanent-looking error.
    if (!retried && (res.status === 403 || res.status === 401)) {
      session = { cookie: null, fetchedAt: 0 };
      return postForm(path, params, { retried: true });
    }
    const snippet = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`TEFAS request failed (${path}): HTTP ${res.status}${snippet ? ` — ${snippet}` : ""}`);
  }

  const json = await res.json();
  return Array.isArray(json?.data) ? json.data : [];
}

/**
 * Fetch daily NAV history for a single fund code over a date range.
 * @returns {Promise<Array<{date: Date, price: number}>>}
 */
async function fetchFundHistory(fundCode, { days = 90 } = {}) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);

  const rows = await postForm("/api/DB/BindHistoryInfo", {
    fontip: "YAT",
    fonkod: fundCode,
    bastarih: formatDate(start),
    bittarih: formatDate(end),
  });

  return rows
    .map((row) => ({
      date: parseNetDate(row.TARIH),
      price: Number(row.FIYAT),
      title: row.FONUNVAN,
      shareCount: row.TEDPAYSAYISI != null ? Number(row.TEDPAYSAYISI) : null,
      investorCount: row.KISISAYISI != null ? Number(row.KISISAYISI) : null,
      marketCap: row.PORTFOYBUYUKLUK != null ? Number(row.PORTFOYBUYUKLUK) : null,
    }))
    .filter((row) => row.date && Number.isFinite(row.price))
    .sort((a, b) => a.date - b.date);
}

// Fields present on every allocation row that are not asset-class weights.
const ALLOCATION_META_KEYS = new Set([
  "FONKODU",
  "FONUNVAN",
  "TARIH",
  "BILGI",
]);

function prettifyKey(key) {
  return key
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());
}

/**
 * Fetch the most recent asset-allocation breakdown (stocks / bonds / gold /
 * repo / etc. as % of the fund) for a single fund code.
 *
 * TEFAS does not fix the set of asset-class columns across fund types, so
 * rather than hardcoding column names, every numeric, non-zero field on the
 * most recent row is treated as an allocation slice.
 *
 * @returns {Promise<{ asOf: Date|null, slices: Array<{label: string, percent: number}> }>}
 */
async function fetchFundAllocation(fundCode, { days = 30 } = {}) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);

  const rows = await postForm("/api/DB/BindHistoryAllocation", {
    fontip: "YAT",
    fonkod: fundCode,
    bastarih: formatDate(start),
    bittarih: formatDate(end),
  });

  if (rows.length === 0) {
    return { asOf: null, slices: [] };
  }

  const latest = rows.reduce((best, row) => {
    const d = parseNetDate(row.TARIH);
    if (!d) return best;
    if (!best || d > best._date) return { ...row, _date: d };
    return best;
  }, null);

  if (!latest) return { asOf: null, slices: [] };

  const slices = Object.entries(latest)
    .filter(([key]) => !ALLOCATION_META_KEYS.has(key) && key !== "_date")
    .map(([key, value]) => ({ label: prettifyKey(key), percent: Number(value) }))
    .filter((slice) => Number.isFinite(slice.percent) && slice.percent > 0.01)
    .sort((a, b) => b.percent - a.percent);

  return { asOf: latest._date, slices };
}

module.exports = { fetchFundHistory, fetchFundAllocation };
