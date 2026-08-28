const path = require("path");
const express = require("express");
const { buildPortfolioSnapshot } = require("./src/services/portfolioService");
const { fetchMarketSnapshot } = require("./src/services/market");
const { buyFund, sellFund, depositCash, withdrawCash, TradeError } = require("./src/services/tradeService");
const { fetchNews } = require("./src/services/news");
const { analyzeMarket, isConfigured: aiConfigured } = require("./src/services/aiAnalysis");

const PORT = Number(process.env.PORT) || 3000;
// TEFAS only publishes new fund prices once a trading day, so there's no
// benefit to refreshing that side every few seconds — and TEFAS's API
// rate-limits to ~6 requests/minute (see src/services/tefas.js), so a
// portfolio of a dozen funds (2 requests each) takes a few minutes to
// refresh regardless. 10 minutes leaves headroom above that. The market
// ticker is a different host with no such limit, refreshed much faster.
const PORTFOLIO_REFRESH_MS = Number(process.env.PORTFOLIO_REFRESH_MS) || 10 * 60 * 1000;
const MARKET_REFRESH_MS = Number(process.env.MARKET_REFRESH_MS) || 60 * 1000;
const NEWS_REFRESH_MS = Number(process.env.NEWS_REFRESH_MS) || 30 * 60 * 1000;
// AI analysis costs real (small) money per call — see aiAnalysis.js — so it
// defaults to a slow cadence. Increase this only if you're fine with more
// frequent Anthropic API usage; the "Analyze now" button in the UI can
// always trigger one on demand regardless of this interval.
const AI_REFRESH_MS = Number(process.env.AI_REFRESH_MS) || 6 * 60 * 60 * 1000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const cache = {
  portfolio: null,
  portfolioError: null,
  portfolioUpdatedAt: null,
  market: null,
  marketUpdatedAt: null,
  news: null,
  newsUpdatedAt: null,
  insights: null,
  insightsUpdatedAt: null,
};

async function refreshPortfolio() {
  try {
    cache.portfolio = await buildPortfolioSnapshot();
    cache.portfolioError = null;
  } catch (err) {
    cache.portfolioError = err.message;
    console.error("[portfolio] refresh failed:", err.message);
  }
  cache.portfolioUpdatedAt = new Date().toISOString();
}

// After a trade, reuse already-priced funds' TEFAS data instead of a full
// re-fetch, so the dashboard reflects the trade in seconds rather than
// waiting through the rate limit again for every unrelated fund. A newly
// bought fund the cache has never seen still gets a real (fast, single-
// fund) TEFAS fetch — see portfolioService.buildPortfolioSnapshot.
async function quickRefreshPortfolio() {
  try {
    cache.portfolio = await buildPortfolioSnapshot({ reuseFrom: cache.portfolio });
    cache.portfolioError = null;
  } catch (err) {
    cache.portfolioError = err.message;
    console.error("[portfolio] quick refresh failed:", err.message);
  }
  cache.portfolioUpdatedAt = new Date().toISOString();
}

// A refresh can take a few minutes (TEFAS's rate limit), so this
// reschedules itself after each run completes instead of using
// setInterval, which would otherwise start overlapping refreshes if one
// ever ran longer than PORTFOLIO_REFRESH_MS.
async function schedulePortfolioRefresh() {
  await refreshPortfolio();
  setTimeout(schedulePortfolioRefresh, PORTFOLIO_REFRESH_MS);
}

async function refreshMarket() {
  try {
    cache.market = await fetchMarketSnapshot();
  } catch (err) {
    console.error("[market] refresh failed:", err.message);
  }
  cache.marketUpdatedAt = new Date().toISOString();
}

async function refreshNews() {
  try {
    cache.news = await fetchNews();
  } catch (err) {
    console.error("[news] refresh failed:", err.message);
  }
  cache.newsUpdatedAt = new Date().toISOString();
}

async function refreshInsights() {
  if (!aiConfigured()) {
    cache.insights = { available: false };
    cache.insightsUpdatedAt = new Date().toISOString();
    return;
  }
  try {
    cache.insights = await analyzeMarket({
      funds: cache.portfolio?.funds || [],
      articles: cache.news?.articles || [],
    });
  } catch (err) {
    cache.insights = { available: true, error: err.message };
    console.error("[insights] refresh failed:", err.message);
  }
  cache.insightsUpdatedAt = new Date().toISOString();
}

app.get("/api/portfolio", (req, res) => {
  if (!cache.portfolio) {
    return res.status(503).json({ error: cache.portfolioError || "Portfolio data is still loading." });
  }
  res.json(cache.portfolio);
});

app.get("/api/market", (req, res) => {
  res.json({ updatedAt: cache.marketUpdatedAt, quotes: cache.market || [] });
});

app.get("/api/news", (req, res) => {
  res.json({ updatedAt: cache.newsUpdatedAt, ...(cache.news || { articles: [], sourceErrors: [] }) });
});

app.get("/api/insights", (req, res) => {
  res.json({ updatedAt: cache.insightsUpdatedAt, ...(cache.insights || { available: false }) });
});

app.post("/api/insights/refresh", async (req, res) => {
  if (!aiConfigured()) {
    return res.status(400).json({ error: "AI analysis isn't configured — set ANTHROPIC_API_KEY to enable it." });
  }
  await refreshInsights();
  res.json({ ok: true, insights: cache.insights });
});

app.get("/api/status", (req, res) => {
  res.json({
    portfolioUpdatedAt: cache.portfolioUpdatedAt,
    portfolioError: cache.portfolioError,
    marketUpdatedAt: cache.marketUpdatedAt,
    newsUpdatedAt: cache.newsUpdatedAt,
    insightsUpdatedAt: cache.insightsUpdatedAt,
    aiConfigured: aiConfigured(),
    portfolioRefreshMs: PORTFOLIO_REFRESH_MS,
    marketRefreshMs: MARKET_REFRESH_MS,
    newsRefreshMs: NEWS_REFRESH_MS,
    aiRefreshMs: AI_REFRESH_MS,
  });
});

app.post("/api/refresh", async (req, res) => {
  // Deliberately excludes AI insights: that costs real money per call (see
  // aiAnalysis.js), so it only runs on its own slow schedule or the
  // separate, explicit "Analyze now" button (/api/insights/refresh) —
  // never as a side effect of the free "Refresh now" button.
  await Promise.all([refreshPortfolio(), refreshMarket(), refreshNews()]);
  res.json({ ok: true });
});

app.post("/api/trade", async (req, res) => {
  const { action, code, quantity, price, date, label } = req.body || {};
  try {
    if (action === "buy") {
      await buyFund({ code, quantity, price, date, label });
    } else if (action === "sell") {
      await sellFund({ code, quantity, price, date });
    } else {
      return res.status(400).json({ error: 'action must be "buy" or "sell".' });
    }
    // If the very first portfolio refresh hasn't landed yet, there's
    // nothing to reuse — a "quick" refresh would fall back to a full,
    // multi-minute TEFAS fetch and this request would hang for it. Skip
    // it: the trade is already saved, and the in-flight initial refresh
    // (or the client's own polling) will pick it up shortly.
    if (cache.portfolio) await quickRefreshPortfolio();
    res.json({ ok: true, portfolio: cache.portfolio });
  } catch (err) {
    if (err instanceof TradeError) return res.status(400).json({ error: err.message });
    console.error("[trade] failed:", err.message);
    res.status(500).json({ error: "Trade failed unexpectedly." });
  }
});

app.post("/api/balance", async (req, res) => {
  const { action, amount, date, note } = req.body || {};
  try {
    if (action === "deposit") {
      await depositCash({ amount, date, note });
    } else if (action === "withdraw") {
      await withdrawCash({ amount, date, note });
    } else {
      return res.status(400).json({ error: 'action must be "deposit" or "withdraw".' });
    }
    // See the matching comment in /api/trade above.
    if (cache.portfolio) await quickRefreshPortfolio();
    res.json({ ok: true, portfolio: cache.portfolio });
  } catch (err) {
    if (err instanceof TradeError) return res.status(400).json({ error: err.message });
    console.error("[balance] failed:", err.message);
    res.status(500).json({ error: "Balance update failed unexpectedly." });
  }
});

app.listen(PORT, () => {
  console.log(`Market & fund dashboard running at http://localhost:${PORT}`);
  schedulePortfolioRefresh();
  refreshMarket();
  setInterval(refreshMarket, MARKET_REFRESH_MS);
  refreshNews();
  setInterval(refreshNews, NEWS_REFRESH_MS);

  if (aiConfigured()) {
    console.log(`AI market analysis enabled (refreshing every ${Math.round(AI_REFRESH_MS / 60000)} min).`);
    // Give the first portfolio/news refresh a head start so the first AI
    // analysis has real data to work with, rather than analyzing nothing.
    setTimeout(refreshInsights, 30 * 1000);
    setInterval(refreshInsights, AI_REFRESH_MS);
  } else {
    cache.insights = { available: false };
    cache.insightsUpdatedAt = new Date().toISOString();
    console.log("AI market analysis disabled (set ANTHROPIC_API_KEY to enable).");
  }
});
