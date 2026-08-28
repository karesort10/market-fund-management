const fs = require("fs");
const path = require("path");
const { fetchFundHistory, fetchFundAllocation } = require("./tefas");
const { fetchFundHoldings } = require("./fintables");

const PORTFOLIO_PATH = path.join(__dirname, "..", "..", "data", "portfolio.json");

// TEFAS's endpoint will reject bursts of near-simultaneous requests (looks
// like rate limiting / anti-bot), which is what silently broke price
// history and profit once the portfolio grew past a couple of funds. Fetch
// funds in small batches instead of all-at-once.
const FUND_FETCH_CONCURRENCY = 3;

function loadPortfolioConfig() {
  const raw = fs.readFileSync(PORTFOLIO_PATH, "utf8");
  return JSON.parse(raw);
}

function summarizeLots(lots) {
  const quantity = lots.reduce((sum, lot) => sum + lot.quantity, 0);
  const cost = lots.reduce((sum, lot) => sum + lot.quantity * lot.price, 0);
  return { quantity, cost, avgCost: quantity > 0 ? cost / quantity : 0 };
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function loadFund(fund) {
  const { quantity, cost, avgCost } = summarizeLots(fund.lots);

  const [history, allocation, holdings] = await Promise.all([
    fetchFundHistory(fund.code).catch((err) => ({ error: err.message, rows: [] })),
    fetchFundAllocation(fund.code).catch((err) => ({ error: err.message, slices: [] })),
    fetchFundHoldings(fund.code).catch((err) => ({ ok: false, error: err.message, holdings: [] })),
  ]);

  const historyRows = Array.isArray(history) ? history : history.rows || [];
  const historyError = Array.isArray(history) ? null : history.error;
  const latest = historyRows[historyRows.length - 1] || null;
  const currentPrice = latest ? latest.price : null;
  const currentValue = currentPrice != null ? currentPrice * quantity : null;
  const profit = currentValue != null ? currentValue - cost : null;
  const profitPercent = profit != null && cost > 0 ? (profit / cost) * 100 : null;

  return {
    code: fund.code,
    label: fund.label || latest?.title || fund.code,
    quantity,
    cost,
    avgCost,
    currentPrice,
    currentValue,
    profit,
    profitPercent,
    priced: currentPrice != null,
    priceHistory: historyRows.map((r) => ({ date: r.date, price: r.price })),
    historyError,
    allocation: allocation.slices || [],
    allocationAsOf: allocation.asOf || null,
    holdings,
  };
}

/**
 * Refresh price history + allocation + holdings for every fund in
 * data/portfolio.json, and compute current value / profit per fund and for
 * the portfolio as a whole.
 */
async function buildPortfolioSnapshot() {
  const config = loadPortfolioConfig();
  const currency = config.currency || "TRY";

  const funds = await mapWithConcurrency(config.funds, FUND_FETCH_CONCURRENCY, loadFund);

  // Funds TEFAS couldn't be reached for fall back to cost basis so totals
  // still render, but they're tracked separately so the UI can say clearly
  // *why* profit looks off instead of quietly showing 0.
  const unpricedFunds = funds.filter((f) => !f.priced).map((f) => f.code);

  const totalCost = funds.reduce((sum, f) => sum + f.cost, 0);
  const totalValue = funds.reduce((sum, f) => sum + (f.currentValue ?? f.cost), 0);
  const totalProfit = totalValue - totalCost;
  const totalProfitPercent = totalCost > 0 ? (totalProfit / totalCost) * 100 : null;

  const allocationByFund = funds.map((f) => ({
    code: f.code,
    label: f.label,
    value: f.currentValue ?? f.cost,
    percent: totalValue > 0 ? ((f.currentValue ?? f.cost) / totalValue) * 100 : 0,
  }));

  return {
    currency,
    generatedAt: new Date().toISOString(),
    totals: {
      cost: totalCost,
      value: totalValue,
      profit: totalProfit,
      profitPercent: totalProfitPercent,
      unpricedFunds,
    },
    allocationByFund,
    funds,
  };
}

module.exports = { buildPortfolioSnapshot, loadPortfolioConfig, PORTFOLIO_PATH };
