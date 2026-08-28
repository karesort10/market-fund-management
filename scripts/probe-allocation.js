// Probe for the hanging asset-allocation endpoint — run with:
//   npm run probe
//
// TEFAS's price endpoint answers in ~400ms while the allocation endpoint
// (identical request body, different path) hangs past 45s. Rather than
// guess at which knob matters, this tries several shapes of the same
// request and reports which — if any — actually return.
//
// Each attempt is spaced out to stay under TEFAS's ~6 requests/minute
// limit, so a full run takes a few minutes. Nothing here is written to
// your portfolio; it only reads.

const FUND = process.argv[2] || "CPU";
const TIMEOUT_MS = 60000;
const SPACING_MS = 12000;

const URL = "https://www.tefas.gov.tr/api/funds/dagilimSiraliGetirT";
const HEADERS = {
  Accept: "*/*",
  "Content-Type": "application/json",
  Origin: "https://www.tefas.gov.tr",
  Referer: "https://www.tefas.gov.tr/tr/fon-verileri",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

function ymd(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// Most recent weekday: allocation is only published on trading days.
function lastWeekday() {
  const d = daysAgo(1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d;
}

function body({ fundCode, start, end, bitSira = 100000 }) {
  return {
    fonTipi: "YAT",
    fonKodu: fundCode,
    aramaMetni: null,
    fonTurKod: null,
    fonGrubu: null,
    sfonTurKod: null,
    fonTurAciklama: null,
    kurucuKod: null,
    basTarih: ymd(start),
    bitTarih: ymd(end),
    basSira: 1,
    bitSira,
    dil: "TR",
    sFonTurKod: "",
    fonKod: "",
    fonGrup: "",
    fonUnvanTip: "",
  };
}

const wd = lastWeekday();

const VARIANTS = [
  {
    name: "A  one fund, single day",
    why: "smallest possible query for this fund",
    body: () => body({ fundCode: FUND, start: wd, end: wd }),
  },
  {
    name: "B  one fund, 3-day window",
    why: "covers a weekend gap, still tiny",
    body: () => body({ fundCode: FUND, start: daysAgo(3), end: new Date() }),
  },
  {
    name: "C  one fund, 10-day window, bitSira=500",
    why: "current app request, but with a small row cap",
    body: () => body({ fundCode: FUND, start: daysAgo(10), end: new Date(), bitSira: 500 }),
  },
  {
    name: "D  ALL funds, single day",
    why: "one daily snapshot for every fund at once — if this works it replaces all per-fund calls",
    body: () => body({ fundCode: null, start: wd, end: wd }),
  },
  {
    name: "E  one fund, 30-day window",
    why: "rules out short ranges being the problem",
    body: () => body({ fundCode: FUND, start: daysAgo(30), end: new Date() }),
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`\nProbing the allocation endpoint (fund: ${FUND}, last weekday: ${ymd(wd)})`);
  console.log(`${VARIANTS.length} attempts, spaced ${SPACING_MS / 1000}s apart, ${TIMEOUT_MS / 1000}s timeout each.`);
  console.log("This takes a few minutes. Nothing is written to your portfolio.\n");

  const results = [];
  for (const [i, v] of VARIANTS.entries()) {
    if (i > 0) await sleep(SPACING_MS);
    process.stdout.write(`  ${v.name} ... `);
    const started = Date.now();
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify(v.body()),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      const ms = Date.now() - started;
      if (!res.ok) {
        console.log(`FAIL (${ms}ms) HTTP ${res.status} ${text.slice(0, 120)}`);
        results.push({ v, ok: false, ms });
        continue;
      }
      const json = JSON.parse(text);
      const rows = Array.isArray(json.resultList) ? json.resultList : [];
      if (json.errorMessage) {
        console.log(`FAIL (${ms}ms) API error: ${json.errorMessage}`);
        results.push({ v, ok: false, ms });
        continue;
      }
      const sample = rows[0] || {};
      const codes = new Set(rows.map((r) => r.fonKodu).filter(Boolean));
      console.log(
        `OK (${ms}ms) ${rows.length} rows, ${codes.size} distinct fund(s)` +
          (sample.tarih ? `, newest date field: ${JSON.stringify(sample.tarih)}` : "")
      );
      results.push({ v, ok: true, ms, rows: rows.length, funds: codes.size });
    } catch (err) {
      const ms = Date.now() - started;
      console.log(`FAIL (${ms}ms) ${err.message}`);
      results.push({ v, ok: false, ms });
    }
  }

  console.log("\n" + "-".repeat(66));
  const winners = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
  if (winners.length === 0) {
    console.log("Every variant failed. The allocation endpoint looks unusable from this");
    console.log("network — the asset-class pie charts can't be fixed by tuning the request.");
  } else {
    console.log("Working request shapes, fastest first:");
    for (const w of winners) {
      console.log(`  ${w.v.name}  — ${w.ms}ms, ${w.rows} rows across ${w.funds} fund(s)`);
      console.log(`      (${w.v.why})`);
    }
    const allFunds = winners.find((w) => w.funds > 1);
    if (allFunds) {
      console.log("\n  Note: the all-funds variant works — one request can serve every fund,");
      console.log("  which is both faster and much gentler on the rate limit.");
    }
  }
  console.log("-".repeat(66));
  console.log("\nPaste this whole output back.\n");
})();
