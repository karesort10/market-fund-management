// Buy/sell trading and cash-balance management against data/portfolio.json.
//
// All mutations go through portfolioService.writePortfolioConfig, which
// owns the single serialized write queue for that file, so a trade landing
// at the same moment as a background label-backfill write (see
// portfolioService.buildPortfolioSnapshot) can never corrupt it with a
// lost update.

const crypto = require("crypto");
const { writePortfolioConfig } = require("./portfolioService");

function today() {
  return new Date().toISOString().slice(0, 10);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function normalizeConfig(config) {
  if (typeof config.cashBalance !== "number") config.cashBalance = 0;
  if (!Array.isArray(config.transactions)) config.transactions = [];
  if (!Array.isArray(config.funds)) config.funds = [];
}

class TradeError extends Error {}

/**
 * Buy `quantity` units of `code` at `price` per unit, deducting the cost
 * from cash balance. Creates a new fund entry if this code isn't already
 * held.
 */
function buyFund({ code, label, quantity, price, date }) {
  code = String(code || "").trim().toUpperCase();
  quantity = Number(quantity);
  price = Number(price);
  if (!code) throw new TradeError("Fund code is required.");
  if (!Number.isFinite(quantity) || quantity <= 0) throw new TradeError("Quantity must be a positive number.");
  if (!Number.isFinite(price) || price <= 0) throw new TradeError("Price must be a positive number.");

  return writePortfolioConfig((config) => {
    normalizeConfig(config);
    const cost = round2(quantity * price);
    if (cost > config.cashBalance) {
      throw new TradeError(
        `Insufficient cash balance: need ${cost.toFixed(2)} ${config.currency}, have ${config.cashBalance.toFixed(2)} ${config.currency}. Deposit funds first.`
      );
    }

    let fund = config.funds.find((f) => f.code === code);
    if (!fund) {
      // Leave label unset rather than defaulting it to the code: that way
      // the next successful TEFAS fetch fills in the fund's real title
      // instead of the code being stuck there permanently (see the
      // label-backfill in portfolioService.buildPortfolioSnapshot).
      fund = { code, label: label || null, lots: [] };
      config.funds.push(fund);
    }
    fund.lots.push({ date: date || today(), quantity, price });

    config.cashBalance = round2(config.cashBalance - cost);
    config.transactions.push({
      id: crypto.randomUUID(),
      date: date || today(),
      type: "buy",
      code,
      quantity,
      price,
      amount: cost,
    });

    return { code, quantity, price, cost, cashBalance: config.cashBalance };
  });
}

/**
 * Sell `quantity` units of `code` at `price` per unit, consuming lots
 * FIFO (oldest purchase first) and crediting proceeds to cash balance.
 * Realized profit/loss is computed against the cost basis of the lots
 * actually consumed. Removes the fund entirely once its quantity hits 0.
 */
function sellFund({ code, quantity, price, date }) {
  code = String(code || "").trim().toUpperCase();
  quantity = Number(quantity);
  price = Number(price);
  if (!code) throw new TradeError("Fund code is required.");
  if (!Number.isFinite(quantity) || quantity <= 0) throw new TradeError("Quantity must be a positive number.");
  if (!Number.isFinite(price) || price <= 0) throw new TradeError("Price must be a positive number.");

  return writePortfolioConfig((config) => {
    normalizeConfig(config);
    const fund = config.funds.find((f) => f.code === code);
    const held = fund ? fund.lots.reduce((sum, l) => sum + l.quantity, 0) : 0;
    if (!fund || held < quantity) {
      throw new TradeError(`You only hold ${held} units of ${code}, can't sell ${quantity}.`);
    }

    let remaining = quantity;
    let costBasisSold = 0;
    const sortedLots = [...fund.lots].sort((a, b) => new Date(a.date) - new Date(b.date));
    const newLots = [];
    for (const lot of sortedLots) {
      if (remaining <= 0) {
        newLots.push(lot);
        continue;
      }
      const take = Math.min(lot.quantity, remaining);
      costBasisSold += take * lot.price;
      remaining -= take;
      const leftoverQty = lot.quantity - take;
      if (leftoverQty > 0) newLots.push({ ...lot, quantity: leftoverQty });
    }
    fund.lots = newLots;
    if (fund.lots.length === 0) {
      config.funds = config.funds.filter((f) => f.code !== code);
    }

    const proceeds = round2(quantity * price);
    const realizedPL = round2(proceeds - costBasisSold);

    config.cashBalance = round2(config.cashBalance + proceeds);
    config.transactions.push({
      id: crypto.randomUUID(),
      date: date || today(),
      type: "sell",
      code,
      quantity,
      price,
      amount: proceeds,
      realizedPL,
    });

    return { code, quantity, price, proceeds, realizedPL, cashBalance: config.cashBalance };
  });
}

/** Add cash to the balance (e.g. a bank deposit earmarked for investing). */
function depositCash({ amount, date, note }) {
  amount = Number(amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new TradeError("Deposit amount must be a positive number.");

  return writePortfolioConfig((config) => {
    normalizeConfig(config);
    config.cashBalance = round2(config.cashBalance + amount);
    config.transactions.push({
      id: crypto.randomUUID(),
      date: date || today(),
      type: "deposit",
      amount,
      note: note || null,
    });
    return { cashBalance: config.cashBalance };
  });
}

/** Remove cash from the balance (e.g. withdrawing to a bank account). */
function withdrawCash({ amount, date, note }) {
  amount = Number(amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new TradeError("Withdrawal amount must be a positive number.");

  return writePortfolioConfig((config) => {
    normalizeConfig(config);
    if (amount > config.cashBalance) {
      throw new TradeError(`Insufficient cash balance: have ${config.cashBalance.toFixed(2)} ${config.currency}.`);
    }
    config.cashBalance = round2(config.cashBalance - amount);
    config.transactions.push({
      id: crypto.randomUUID(),
      date: date || today(),
      type: "withdraw",
      amount,
      note: note || null,
    });
    return { cashBalance: config.cashBalance };
  });
}

module.exports = { buyFund, sellFund, depositCash, withdrawCash, TradeError };
