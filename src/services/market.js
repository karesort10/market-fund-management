// General market snapshot (index / FX / gold) via Yahoo Finance's public,
// unauthenticated chart endpoint. This is intraday-real-time (unlike TEFAS
// fund NAVs, which only publish once per trading day), which is what makes
// the dashboard feel "live" between fund NAV updates.

const SYMBOLS = [
  { symbol: "XU100.IS", label: "BIST 100" },
  { symbol: "TRY=X", label: "USD/TRY" },
  { symbol: "EURTRY=X", label: "EUR/TRY" },
  { symbol: "GC=F", label: "Gold (oz, USD)" },
];

async function fetchQuote({ symbol, label }) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; market-fund-management/1.0)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta) throw new Error("no meta in response");

    const price = meta.regularMarketPrice;
    const prevClose = meta.previousClose ?? meta.chartPreviousClose;
    const change = price != null && prevClose ? price - prevClose : null;
    const changePercent = change != null && prevClose ? (change / prevClose) * 100 : null;

    return {
      symbol,
      label,
      price: price ?? null,
      currency: meta.currency ?? null,
      change,
      changePercent,
      asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000) : null,
      ok: true,
    };
  } catch (err) {
    return { symbol, label, ok: false, error: err.message };
  }
}

async function fetchMarketSnapshot() {
  return Promise.all(SYMBOLS.map(fetchQuote));
}

module.exports = { fetchMarketSnapshot };
