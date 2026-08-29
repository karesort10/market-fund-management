// Connectivity diagnostic — run with: npm run diagnose
//
// Every data source this app uses is a third party that can block, move,
// or rate-limit us, and the failure looks identical from the UI ("HTTP
// 403", "timeout"). This hits each one directly from YOUR machine and
// reports exactly what happened, so a fix can target the real cause
// instead of being guessed at.
//
// It makes a handful of requests and takes well under a minute.

const TEST_FUND = process.argv[2] || "CPU";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function ymd(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

async function timed(label, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    console.log(`  OK    ${label}  (${Date.now() - started}ms) ${detail || ""}`);
    return true;
  } catch (err) {
    console.log(`  FAIL  ${label}  (${Date.now() - started}ms) -> ${err.message}`);
    return false;
  }
}

async function tefasCall(path, extraDays, timeoutMs) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - extraDays);
  const res = await fetch(`https://www.tefas.gov.tr${path}`, {
    method: "POST",
    headers: {
      Accept: "*/*",
      "Content-Type": "application/json",
      Origin: "https://www.tefas.gov.tr",
      Referer: "https://www.tefas.gov.tr/tr/fon-verileri",
      "User-Agent": BROWSER_UA,
    },
    body: JSON.stringify({
      fonTipi: "YAT",
      fonKodu: TEST_FUND,
      aramaMetni: null,
      fonTurKod: null,
      fonGrubu: null,
      sfonTurKod: null,
      fonTurAciklama: null,
      kurucuKod: null,
      basTarih: ymd(start),
      bitTarih: ymd(end),
      basSira: 1,
      bitSira: 100000,
      dil: "TR",
      sFonTurKod: "",
      fonKod: "",
      fonGrup: "",
      fonUnvanTip: "",
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${text.slice(0, 160)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response: ${text.slice(0, 160)}`);
  }
  const rows = Array.isArray(json.resultList) ? json.resultList : [];
  if (json.errorMessage) throw new Error(`API error: ${json.errorMessage}`);
  return `${rows.length} rows`;
}

(async () => {
  console.log(`\nDiagnosing data sources (test fund: ${TEST_FUND})\n`);

  console.log("TEFAS — fund prices and asset allocation (required):");
  const priceOk = await timed("price history   POST /api/funds/fonGnlBlgSiraliGetir", () =>
    tefasCall("/api/funds/fonGnlBlgSiraliGetir", 27, 20000)
  );
  // This endpoint ignores the fund filter and returns every fund, so cost
  // scales with the date window, not the portfolio — a few days only.
  const allocOk = await timed("asset allocation POST /api/funds/dagilimSiraliGetirT", () =>
    tefasCall("/api/funds/dagilimSiraliGetirT", 3, 45000)
  );

  console.log("\nFintables — individual stock holdings inside each fund (optional):");
  const fintablesOk = await timed(`GET fintables.com/fonlar/${TEST_FUND}`, async () => {
    const res = await fetch(`https://fintables.com/fonlar/${TEST_FUND}`, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.text();
    if (!res.ok) {
      const cf = /cloudflare|cf-ray|attention required|just a moment/i.test(body) ? " [Cloudflare block detected]" : "";
      throw new Error(`HTTP ${res.status}${cf}`);
    }
    return `${body.length} bytes of HTML`;
  });

  console.log("\nMarket ticker and news (optional):");
  await timed("Yahoo Finance  BIST 100 quote", async () => {
    const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/XU100.IS?range=1d&interval=5m", {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return price != null ? `BIST 100 = ${price}` : "responded, but no price field";
  });

  for (const [name, url] of [
    ["Bloomberg HT", "https://www.bloomberght.com/rss"],
    ["Dünya Gazetesi", "https://www.dunya.com/rss"],
    ["Anadolu Ajansı", "https://www.aa.com.tr/tr/rss/default?cat=ekonomi"],
    ["Investing.com", "https://www.investing.com/rss/news_25.rss"],
  ]) {
    await timed(`RSS ${name}`, async () => {
      const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      return `${(body.match(/<item[\s>]/gi) || []).length} items`;
    });
  }

  console.log("\n" + "-".repeat(62));
  console.log("Summary:");
  console.log(`  Prices / profit / charts : ${priceOk ? "WORKING" : "BROKEN — the dashboard needs this"}`);
  console.log(`  Asset allocation pies    : ${allocOk ? "WORKING" : "BROKEN"}`);
  console.log(
    `  Individual stock holdings: ${fintablesOk ? "WORKING" : "BLOCKED — expected; see README, this source blocks automated requests"}`
  );
  console.log("-".repeat(62));
  console.log("\nPaste this whole output back if you want help acting on it.\n");
})();
