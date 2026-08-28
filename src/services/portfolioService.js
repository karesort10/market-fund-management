const fs = require("fs");
const path = require("path");
const { fetchFundHistory, fetchFundAllocation } = require("./tefas");
const { fetchFundHoldings } = require("./fintables");

const PORTFOLIO_PATH = path.join(__dirname, "..", "..", "data", "portfolio.json");

function loadPortfolioConfig() {
  const raw = fs.readFileSync(PORTFOLIO_PATH, "utf8");
  return JSON.parse(raw);
}

function summarizeLots(lots) {
  const quantity = lots.reduce((sum, lot) => sum + lot.quantity, 0);
  const cost = lots.reduce((sum, lot) => sum + lot.quantity * lot.price, 0);
  return { quantity, cost, avgCost: quantity > 0 ? cost / quantity : 0 };
}

/**
 * Refresh price history + allocation + holdings for every fund in
 * data/portfolio.json, and compute current value / profit per fund and for
 * the portfolio as a whole.
 */
async function buildPortfolioSnapshot() {
  const config = loadPortfolioConfig();
  const currency = config.currency || "TRY";

  const funds = await Promise.all(
    config.funds.map(async (fund) => {
      const { quantity, cost, avgCost } = summarizeLots(fund.lots);

      const [history, allocation, holdings] = await Promise.all([
        fetchFundHistory(fund.code).catch((err) => ({ error: err.message, rows: [] })),
        fetchFundAllocation(fund.code).catch((err) => ({ error: err.message, slices: [] })),
        fetchFundHoldings(fund.code).catch((err) => ({ ok: false, error: err.message, holdings: [] })),
      ]);

      const historyRows = Array.isArray(history) ? history : history.rows || [];
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
        priceHistory: historyRows.map((r) => ({ date: r.date, price: r.price })),
        historyError: history.error || null,
        allocation: allocation.slices || [],
        allocationAsOf: allocation.asOf || null,
        holdings,
      };
    })
  );

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
    totals: { cost: totalCost, value: totalValue, profit: totalProfit, profitPercent: totalProfitPercent },
    allocationByFund,
    funds,
  };
}

module.exports = { buildPortfolioSnapshot, loadPortfolioConfig, PORTFOLIO_PATH };
