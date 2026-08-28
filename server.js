const path = require("path");
const express = require("express");
const { buildPortfolioSnapshot } = require("./src/services/portfolioService");
const { fetchMarketSnapshot } = require("./src/services/market");

const PORT = Number(process.env.PORT) || 3000;
// TEFAS only publishes new fund prices once a trading day, so there's no
// benefit to refreshing that side every few seconds — and TEFAS's API
// rate-limits to ~6 requests/minute (see src/services/tefas.js), so a
// portfolio of a dozen funds (2 requests each) takes a few minutes to
// refresh regardless. 10 minutes leaves headroom above that. The market
// ticker is a different host with no such limit, refreshed much faster.
const PORTFOLIO_REFRESH_MS = Number(process.env.PORTFOLIO_REFRESH_MS) || 10 * 60 * 1000;
const MARKET_REFRESH_MS = Number(process.env.MARKET_REFRESH_MS) || 60 * 1000;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const cache = {
  portfolio: null,
  portfolioError: null,
  portfolioUpdatedAt: null,
  market: null,
  marketUpdatedAt: null,
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

app.get("/api/portfolio", (req, res) => {
  if (!cache.portfolio) {
    return res.status(503).json({ error: cache.portfolioError || "Portfolio data is still loading." });
  }
  res.json(cache.portfolio);
});

app.get("/api/market", (req, res) => {
  res.json({ updatedAt: cache.marketUpdatedAt, quotes: cache.market || [] });
});

app.get("/api/status", (req, res) => {
  res.json({
    portfolioUpdatedAt: cache.portfolioUpdatedAt,
    portfolioError: cache.portfolioError,
    marketUpdatedAt: cache.marketUpdatedAt,
    portfolioRefreshMs: PORTFOLIO_REFRESH_MS,
    marketRefreshMs: MARKET_REFRESH_MS,
  });
});

app.post("/api/refresh", async (req, res) => {
  await Promise.all([refreshPortfolio(), refreshMarket()]);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Market & fund dashboard running at http://localhost:${PORT}`);
  schedulePortfolioRefresh();
  refreshMarket();
  setInterval(refreshMarket, MARKET_REFRESH_MS);
});
