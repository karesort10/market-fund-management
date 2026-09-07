const fs = require("fs");
const path = require("path");
const { fetchFundHistory, fetchAllAllocations } = require("./tefas");
const { fetchFundHoldings } = require("./fintables");

const PORTFOLIO_PATH = path.join(__dirname, "..", "..", "data", "portfolio.json");

// TEFAS's endpoint will reject bursts of near-simultaneous requests (looks
// like rate limiting / anti-bot), which is what silently broke price
// history and profit once the portfolio grew past a couple of funds. Fetch
// funds in small batches instead of all-at-once.
const FUND_FETCH_CONCURRENCY = 3;

// How long a successfully-fetched asset allocation / holdings breakdown is
// reused before being re-fetched. This data changes on the order of weeks,
// while prices change daily, so re-pulling it every refresh cycle would
// roughly double every refresh's cost for nothing.
const COMPOSITION_TTL_MS = 12 * 60 * 60 * 1000;

function loadPortfolioConfig() {
  const raw = fs.readFileSync(PORTFOLIO_PATH, "utf8");
  return JSON.parse(raw);
}

// The single place that writes data/portfolio.json. Every writer (trades,
// balance changes, this module's own label-backfill below) goes through
// this queue so two writes can never race and clobber each other.
let writeQueue = Promise.resolve();
function writePortfolioConfig(mutateFn) {
  const result = writeQueue.then(() => {
    const config = loadPortfolioConfig();
    const returnValue = mutateFn(config);
    fs.writeFileSync(PORTFOLIO_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
    return returnValue;
  });
  writeQueue = result.catch(() => {}); // one failed write must not wedge the queue
  return result;
}

function round2(n) {
  return Math.round(n * 100) / 100;
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

function isFresh(timestamp, ttlMs) {
  if (!timestamp) return false;
  return Date.now() - new Date(timestamp).getTime() < ttlMs;
}

async function loadFund(fund, cachedFund, { reusePrices = false, allocations = null } = {}) {
  const { quantity, cost, avgCost } = summarizeLots(fund.lots);
  const now = new Date().toISOString();

  // Price, allocation and holdings are fetched in parallel. TEFAS's own
  // two calls get serialized by that module's rate-limit queue anyway, but
  // Fintables is a different host with no such queue, so running them
  // together still saves real time.
  const [priceResult, allocationResult, holdingsResult] = await Promise.all([
    (async () => {
      // Reused only right after a trade, so buying/selling a fund that was
      // already priced reflects instantly instead of waiting through
      // TEFAS's rate limit again for every unrelated fund. Scheduled
      // refreshes always re-fetch, since the NAV is the whole point.
      if (reusePrices && cachedFund && cachedFund.priced) {
        return {
          rows: (cachedFund.priceHistory || []).map((r) => ({ date: new Date(r.date), price: r.price })),
          error: null,
        };
      }
      const history = await fetchFundHistory(fund.code).catch((err) => ({ error: err.message, rows: [] }));
      return {
        rows: Array.isArray(history) ? history : history.rows || [],
        error: Array.isArray(history) ? null : history.error,
      };
    })(),

    (async () => {
      // Allocation is not fetched here: one bulk call up in
      // buildPortfolioSnapshot covers every fund at once (the endpoint
      // returns all funds regardless of what you ask for). `allocations`
      // is that result, or null when a still-fresh cached value made the
      // bulk call unnecessary.
      if (allocations) {
        if (allocations.error) {
          return { slices: [], asOf: null, error: allocations.error, fetchedAt: null };
        }
        const hit = allocations.byCode.get(fund.code);
        return {
          slices: hit ? hit.slices : [],
          asOf: hit ? hit.asOf : null,
          // A fund missing from an otherwise-successful response simply
          // has no breakdown published; that is not an error. Timestamp
          // it anyway so we don't re-request on every single cycle.
          error: null,
          fetchedAt: now,
        };
      }
      return {
        slices: cachedFund?.allocation || [],
        asOf: cachedFund?.allocationAsOf || null,
        error: cachedFund?.allocationError || null,
        fetchedAt: cachedFund?.allocationFetchedAt || null,
      };
    })(),

    (async () => {
      // Same success-cached / failure-retried rule as allocation — also
      // keeps this from re-scraping Fintables every few minutes.
      if (cachedFund && cachedFund.holdings?.ok && isFresh(cachedFund.holdingsFetchedAt, COMPOSITION_TTL_MS)) {
        return { holdings: cachedFund.holdings, fetchedAt: cachedFund.holdingsFetchedAt };
      }
      const holdings = await fetchFundHoldings(fund.code).catch((err) => ({
        ok: false,
        error: err.message,
        holdings: [],
      }));
      return { holdings, fetchedAt: holdings.ok ? now : null };
    })(),
  ]);

  const historyRows = priceResult.rows;
  const historyError = priceResult.error;
  const allocationSlices = { slices: allocationResult.slices, asOf: allocationResult.asOf };
  const allocationError = allocationResult.error;
  const allocationFetchedAt = allocationResult.fetchedAt;
  const holdings = holdingsResult.holdings;
  const holdingsFetchedAt = holdingsResult.fetchedAt;

  const latest = historyRows[historyRows.length - 1] || null;
  const currentPrice = latest ? latest.price : null;
  const currentValue = currentPrice != null ? currentPrice * quantity : null;
  const profit = currentValue != null ? currentValue - cost : null;
  const profitPercent = profit != null && cost > 0 ? (profit / cost) * 100 : null;

  // Day-over-day move. TEFAS publishes one NAV per *trading* day, so the
  // previous row is the previous trading day — on a Monday that's Friday,
  // not literally yesterday. previousDate is carried through so the UI can
  // name the date being compared against instead of claiming "24h".
  const previous = historyRows[historyRows.length - 2] || null;
  const previousPrice = previous ? previous.price : null;
  const previousDate = previous ? previous.date : null;
  const canCompare = currentPrice != null && previousPrice != null && previousPrice > 0;
  const dayChangePercent = canCompare ? ((currentPrice - previousPrice) / previousPrice) * 100 : null;
  const dayChangeValue = canCompare ? (currentPrice - previousPrice) * quantity : null;

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
    previousPrice,
    previousDate,
    dayChangePercent,
    dayChangeValue,
    priced: currentPrice != null,
    priceHistory: historyRows.map((r) => ({ date: r.date, price: r.price })),
    historyError,
    allocation: allocationSlices.slices || [],
    allocationAsOf: allocationSlices.asOf || null,
    allocationError,
    allocationFetchedAt,
    holdings,
    holdingsFetchedAt,
  };
}

/**
 * Refresh price history + allocation + holdings for every fund in
 * data/portfolio.json, and compute current value / profit per fund and for
 * the portfolio as a whole.
 *
 * @param {{ reuseFrom?: object, reusePrices?: boolean }} opts
 *   `reuseFrom` is a previous snapshot (typically the server-side cache)
 *   to reuse slow-moving data from. Pass it on scheduled refreshes too:
 *   prices are still re-fetched, but a recent allocation/holdings result
 *   is reused rather than re-pulled every cycle (see COMPOSITION_TTL_MS).
 *   `reusePrices` additionally reuses cached prices, for the near-instant
 *   refresh right after a trade.
 */
async function buildPortfolioSnapshot({ reuseFrom, reusePrices = false } = {}) {
  const config = loadPortfolioConfig();
  const currency = config.currency || "TRY";
  const cashBalance = typeof config.cashBalance === "number" ? config.cashBalance : 0;
  const transactions = Array.isArray(config.transactions)
    ? [...config.transactions].sort((a, b) => new Date(b.date) - new Date(a.date))
    : [];

  const cachedByCode = new Map((reuseFrom?.funds || []).map((f) => [f.code, f]));

  // Allocation comes from a single bulk request covering every fund, so
  // it's fetched once here rather than inside loadFund. Skip it entirely
  // while every held fund still has a fresh cached breakdown.
  const needAllocation = config.funds.some((fund) => {
    const cached = cachedByCode.get(fund.code);
    return !(cached && isFresh(cached.allocationFetchedAt, COMPOSITION_TTL_MS));
  });
  let allocations = null;
  if (needAllocation) {
    allocations = await fetchAllAllocations()
      .then((byCode) => ({ byCode }))
      .catch((err) => ({ error: err.message }));
  }

  const funds = await mapWithConcurrency(config.funds, FUND_FETCH_CONCURRENCY, (fund) =>
    loadFund(fund, cachedByCode.get(fund.code), { reusePrices, allocations })
  );

  // A fund bought by code before TEFAS ever resolved its real title only
  // has the code as its label; once a fresh fetch resolves the title,
  // persist it so it doesn't show as just the code forever.
  const resolvedLabels = funds
    .filter((f) => f.label !== f.code && f.label)
    .map((f) => [f.code, f.label]);
  if (resolvedLabels.length > 0) {
    await writePortfolioConfig((cfg) => {
      const labelByCode = new Map(resolvedLabels);
      for (const cfgFund of cfg.funds) {
        const resolved = labelByCode.get(cfgFund.code);
        if (resolved && cfgFund.label !== resolved) cfgFund.label = resolved;
      }
    }).catch(() => {}); // best-effort — the in-memory snapshot below is correct either way
  }

  // Funds TEFAS couldn't be reached for fall back to cost basis so totals
  // still render, but they're tracked separately so the UI can say clearly
  // *why* profit looks off instead of quietly showing 0.
  const unpricedFunds = funds.filter((f) => !f.priced).map((f) => f.code);

  const totalCost = funds.reduce((sum, f) => sum + f.cost, 0);
  const totalValue = funds.reduce((sum, f) => sum + (f.currentValue ?? f.cost), 0);
  const totalProfit = totalValue - totalCost;
  const totalProfitPercent = totalCost > 0 ? (totalProfit / totalCost) * 100 : null;

  // Portfolio day-over-day move. Both sides of this ratio must cover the
  // *same* funds — mixing funds that have a previous price into a total
  // that includes ones that don't would produce a meaningless percentage.
  const comparable = funds.filter((f) => f.currentPrice != null && f.previousPrice != null);
  const previousValue = comparable.reduce((sum, f) => sum + f.previousPrice * f.quantity, 0);
  const comparableValue = comparable.reduce((sum, f) => sum + f.currentPrice * f.quantity, 0);
  const dayChange = comparable.length > 0 ? comparableValue - previousValue : null;
  const dayChangePercent = previousValue > 0 ? (dayChange / previousValue) * 100 : null;
  // The date being compared against — the latest previous trading day
  // seen across the funds that could be compared.
  const comparedTo = comparable.reduce((latestSeen, f) => {
    const d = f.previousDate ? new Date(f.previousDate) : null;
    if (!d || Number.isNaN(d.getTime())) return latestSeen;
    return !latestSeen || d > latestSeen ? d : latestSeen;
  }, null);

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
      dayChange,
      dayChangePercent,
      dayChangeComparedTo: comparedTo ? comparedTo.toISOString() : null,
      // Flags a day change computed from only part of the portfolio, so
      // the UI can say so rather than implying it covers everything.
      dayChangePartial: comparable.length > 0 && comparable.length < funds.length,
      dayChangeFundCount: comparable.length,
    },
    balance: {
      cash: cashBalance,
      fundsValue: totalValue,
      netWorth: round2(cashBalance + totalValue),
    },
    transactions,
    allocationByFund,
    funds,
  };
}

module.exports = { buildPortfolioSnapshot, loadPortfolioConfig, writePortfolioConfig, PORTFOLIO_PATH };
