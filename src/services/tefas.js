// TEFAS (Turkey Electronic Fund Trading Platform) integration.
//
// TEFAS retired its old ASP.NET "BindHistoryInfo"/"BindHistoryAllocation"
// endpoints in 2026 in favor of a JSON API behind a new gateway:
//   POST /api/funds/fonGnlBlgSiraliGetir  -> daily price (NAV) history
//   POST /api/funds/dagilimSiraliGetirT   -> daily asset-allocation breakdown
// (mirrors what actively-maintained community clients such as pytefas call,
// since TEFAS does not publish formal API docs).
//
// Two constraints from that same gateway shape everything below:
// - A single request's date range is capped at roughly a month, so a
//   longer lookback would need to be split into multiple chunked requests.
//   To keep request volume down (see the rate limit below), the price
//   history window is kept to <30 days rather than chunking.
// - The gateway rate-limits aggressively (community clients throttle
//   themselves to ~6 requests/minute to avoid it). All requests are queued
//   through a single throttle so this app never bursts past that pace,
//   regardless of how many funds are being refreshed concurrently.
//
// TEFAS updates a fund's NAV once per trading day (after markets close), so
// "real time" here means "as fresh as the source publishes and the rate
// limit allows", refreshed on an interval rather than streamed tick-by-tick.

const BASE_URL = "https://www.tefas.gov.tr";
const INFO_PATH = "/api/funds/fonGnlBlgSiraliGetir";
const ALLOCATION_PATH = "/api/funds/dagilimSiraliGetirT";
const REQUEST_TIMEOUT_MS = 15 * 1000;
// dagilimSiraliGetirT returns 50+ asset-class columns per row and is much
// slower to respond than the ~9-column price endpoint, routinely taking
// longer than the standard timeout allows. It gets its own, longer one.
const ALLOCATION_TIMEOUT_MS = 45 * 1000;
const MIN_REQUEST_INTERVAL_MS = 10 * 1000; // ~6 requests/minute

const DEFAULT_HEADERS = {
  Accept: "*/*",
  "Content-Type": "application/json",
  Origin: BASE_URL,
  Referer: `${BASE_URL}/tr/fon-verileri`,
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

// Serializes every TEFAS request app-wide, spaced at least
// MIN_REQUEST_INTERVAL_MS apart, no matter how many funds are being
// fetched at once.
let queue = Promise.resolve();
let lastCallAt = 0;
function throttled(fn) {
  const result = queue.then(async () => {
    const wait = Math.max(0, lastCallAt + MIN_REQUEST_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCallAt = Date.now();
    return fn();
  });
  queue = result.catch(() => {}); // one failed call must not wedge the queue
  return result;
}

function formatYmd(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function buildBody(fonTipi, fonKodu, start, end) {
  return {
    fonTipi,
    fonKodu: fonKodu || null,
    aramaMetni: null,
    fonTurKod: null,
    fonGrubu: null,
    sfonTurKod: null,
    fonTurAciklama: null,
    kurucuKod: null,
    basTarih: formatYmd(start),
    bitTarih: formatYmd(end),
    basSira: 1,
    bitSira: 100000,
    dil: "TR",
    sFonTurKod: "",
    fonKod: "",
    fonGrup: "",
    fonUnvanTip: "",
  };
}

async function postJson(path, body, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return throttled(async () => {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: DEFAULT_HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`TEFAS request failed (${path}): HTTP ${res.status} — non-JSON response: ${text.slice(0, 200)}`);
    }

    if (!res.ok) {
      const detail = json.errorMessage || json.faultString || text.slice(0, 200);
      throw new Error(`TEFAS request failed (${path}): HTTP ${res.status} — ${detail}`);
    }

    // TEFAS's gateway can return HTTP 200 with an error payload instead of
    // a non-2xx status; errorCode "0"/0 means success, so only treat a
    // truthy *non-zero* code (or any errorMessage) as failure.
    const hasApiError = json.errorMessage || (json.errorCode && json.errorCode !== "0" && json.errorCode !== 0);
    if (hasApiError) {
      throw new Error(`TEFAS API error (${path}): ${json.errorMessage || json.errorCode}`);
    }

    return Array.isArray(json.resultList) ? json.resultList : [];
  });
}

// Dates come back in whichever format the current gateway happens to use;
// this has changed once already (legacy ASP.NET "/Date(...)/ " wire format
// vs. the new gateway's likely ISO/epoch/YYYYMMDD), so parsing tries every
// shape rather than assuming one.
function parseApiDate(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value === "string") {
    const netMatch = value.match(/\/Date\((\d+)\)\//);
    if (netMatch) return new Date(Number(netMatch[1]));
    if (/^\d{8}$/.test(value)) {
      return new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00`);
    }
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Fetch daily NAV history for a single fund code over a date range.
 * Capped under ~30 days to stay within a single request (see header note).
 * @returns {Promise<Array<{date: Date, price: number}>>}
 */
async function fetchFundHistory(fundCode, { days = 27 } = {}) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);

  const rows = await postJson(INFO_PATH, buildBody("YAT", fundCode, start, end));

  return rows
    .map((row) => ({
      date: parseApiDate(row.tarih),
      price: Number(row.fiyat),
      title: row.fonUnvan,
      shareCount: row.tedPaySayisi != null ? Number(row.tedPaySayisi) : null,
      investorCount: row.kisiSayisi != null ? Number(row.kisiSayisi) : null,
      marketCap: row.portfoyBuyukluk != null ? Number(row.portfoyBuyukluk) : null,
    }))
    .filter((row) => row.date && Number.isFinite(row.price))
    .sort((a, b) => a.date - b.date);
}

// Fields present on every allocation row that are not asset-class weights.
const ALLOCATION_META_KEYS = new Set(["fonKodu", "fonUnvan", "tarih"]);

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
 * The exact set of asset-class columns TEFAS returns isn't fixed across
 * fund types, so rather than hardcoding column names, every numeric,
 * plausible-percentage field on the most recent row is treated as a slice.
 *
 * @returns {Promise<{ asOf: Date|null, slices: Array<{label: string, percent: number}> }>}
 */
function rowToSlices(row) {
  return Object.entries(row)
    .filter(([key]) => !ALLOCATION_META_KEYS.has(key) && key !== "_date")
    .map(([key, value]) => ({ label: prettifyKey(key), percent: Number(value) }))
    .filter((slice) => Number.isFinite(slice.percent) && slice.percent > 0.01 && slice.percent <= 100)
    .sort((a, b) => b.percent - a.percent);
}

/**
 * Fetch the latest asset-allocation breakdown for EVERY fund, in one call.
 *
 * This endpoint ignores the `fonKodu` filter: whatever fund you ask for,
 * it returns a row per fund per day for all ~2000 funds on the platform.
 * Asking for it per-fund therefore downloaded the entire market's
 * allocation data once for every fund held, over a multi-day window —
 * tens of thousands of 50-column rows per request — which is what made
 * this endpoint appear to hang. Cost scales with the date window, so this
 * keeps the window to a few days and takes the newest row per fund.
 *
 * @returns {Promise<Map<string, { asOf: Date, slices: Array<{label: string, percent: number}> }>>}
 */
async function fetchAllAllocations({ days = 3 } = {}) {
  const end = new Date();
  const start = new Date();
  // A few days rather than one, so a weekend or holiday doesn't come back
  // empty — but small, because every extra day is ~2000 more rows.
  start.setDate(start.getDate() - days);

  const rows = await postJson(ALLOCATION_PATH, buildBody("YAT", null, start, end), {
    timeoutMs: ALLOCATION_TIMEOUT_MS,
  });

  const latestByCode = new Map();
  for (const row of rows) {
    const code = row.fonKodu;
    const date = parseApiDate(row.tarih);
    if (!code || !date) continue;
    const existing = latestByCode.get(code);
    if (!existing || date > existing._date) latestByCode.set(code, { ...row, _date: date });
  }

  const byCode = new Map();
  for (const [code, row] of latestByCode) {
    byCode.set(code, { asOf: row._date, slices: rowToSlices(row) });
  }
  return byCode;
}

module.exports = { fetchFundHistory, fetchAllAllocations };
