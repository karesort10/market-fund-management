const fmtMoney = (value, currency = "TRY") =>
  value == null ? "—" : new Intl.NumberFormat("tr-TR", { style: "currency", currency }).format(value);

const fmtPct = (value) => (value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`);

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("tr-TR") : "—");

const CHART_COLORS = [
  "#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed",
  "#0891b2", "#db2777", "#65a30d", "#ea580c", "#4338ca",
];

const charts = {}; // canvas id -> Chart instance, so re-renders destroy the old one first

function renderChart(canvasId, config) {
  const el = document.getElementById(canvasId);
  if (!el) return;
  if (charts[canvasId]) charts[canvasId].destroy();
  charts[canvasId] = new Chart(el, config);
}

// ---- Tabs -----------------------------------------------------------

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

// ---- Market ticker ----------------------------------------------------

async function loadMarket() {
  try {
    const res = await fetch("/api/market");
    const data = await res.json();
    const el = document.getElementById("market-ticker");
    if (!data.quotes || data.quotes.length === 0) {
      el.textContent = "Market data unavailable.";
      return;
    }
    el.innerHTML = data.quotes
      .map((q) => {
        if (!q.ok) return `<span class="quote">${q.label}: <em>unavailable</em></span>`;
        const dir = q.change > 0 ? "up" : q.change < 0 ? "down" : "";
        const arrow = q.change > 0 ? "▲" : q.change < 0 ? "▼" : "";
        return `<span class="quote">${q.label}: <strong>${q.price.toFixed(2)}</strong>
          <span class="${dir}">${arrow} ${q.changePercent != null ? q.changePercent.toFixed(2) + "%" : ""}</span></span>`;
      })
      .join("");
  } catch (err) {
    document.getElementById("market-ticker").textContent = "Market data unavailable.";
  }
}

// ---- Portfolio dashboard ----------------------------------------------

function renderSummary(snapshot) {
  const { totals, currency } = snapshot;
  document.getElementById("summary-value").textContent = fmtMoney(totals.value, currency);
  document.getElementById("summary-cost").textContent = fmtMoney(totals.cost, currency);

  const profitEl = document.getElementById("summary-profit");
  const profitPctEl = document.getElementById("summary-profit-pct");
  const positive = totals.profit >= 0;
  profitEl.textContent = fmtMoney(totals.profit, currency);
  profitEl.className = `card-value ${positive ? "positive" : "negative"}`;
  profitPctEl.textContent = fmtPct(totals.profitPercent);
  profitPctEl.className = `card-sub ${positive ? "positive" : "negative"}`;

  const warning = document.getElementById("dashboard-warning");
  if (totals.unpricedFunds && totals.unpricedFunds.length > 0) {
    warning.hidden = false;
    warning.textContent = `Couldn't fetch a current price for: ${totals.unpricedFunds.join(", ")}. Their value/profit below uses cost basis (shown as unavailable in the table) until the next refresh succeeds.`;
  } else {
    warning.hidden = true;
  }
}

function renderAllocationChart(snapshot) {
  renderChart("allocation-chart", {
    type: "doughnut",
    data: {
      labels: snapshot.allocationByFund.map((f) => f.label),
      datasets: [
        {
          data: snapshot.allocationByFund.map((f) => f.percent),
          backgroundColor: snapshot.allocationByFund.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
        },
      ],
    },
    options: {
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${ctx.parsed.toFixed(1)}%` } },
      },
    },
  });
}

function renderProfitChart(snapshot) {
  renderChart("profit-chart", {
    type: "bar",
    data: {
      labels: snapshot.funds.map((f) => f.code),
      datasets: [
        {
          label: "Profit / Loss",
          data: snapshot.funds.map((f) => f.profit),
          backgroundColor: snapshot.funds.map((f) => (f.profit == null ? "#9ca3af" : f.profit >= 0 ? "#16a34a" : "#dc2626")),
        },
      ],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: { y: { ticks: { callback: (v) => fmtMoney(v, snapshot.currency) } } },
    },
  });
}

function renderHoldingsTable(snapshot) {
  const tbody = document.querySelector("#holdings-table tbody");
  tbody.innerHTML = snapshot.funds
    .map((f) => {
      if (!f.priced) {
        return `<tr>
          <td>${f.label}<br><span class="fund-code">${f.code}</span></td>
          <td>${f.quantity.toLocaleString("tr-TR")}</td>
          <td>${fmtMoney(f.avgCost, snapshot.currency)}</td>
          <td colspan="3" class="holdings-unavailable">Price unavailable${f.historyError ? ` (${f.historyError})` : ""}</td>
        </tr>`;
      }
      const cls = f.profit > 0 ? "positive" : f.profit < 0 ? "negative" : "";
      return `<tr>
        <td>${f.label}<br><span class="fund-code">${f.code}</span></td>
        <td>${f.quantity.toLocaleString("tr-TR")}</td>
        <td>${fmtMoney(f.avgCost, snapshot.currency)}</td>
        <td>${fmtMoney(f.currentPrice, snapshot.currency)}</td>
        <td>${fmtMoney(f.currentValue, snapshot.currency)}</td>
        <td class="${cls}">${fmtMoney(f.profit, snapshot.currency)} (${fmtPct(f.profitPercent)})</td>
      </tr>`;
    })
    .join("");
}

function renderFundHistoryGrid(snapshot) {
  const grid = document.getElementById("fund-history-grid");
  grid.innerHTML = snapshot.funds
    .map((f) => `
      <div class="fund-card">
        <h3>${f.label}</h3>
        <span class="fund-code">${f.code}</span>
        <canvas id="hist-${f.code}" height="160"></canvas>
        ${f.historyError ? `<p class="holdings-unavailable">Price history unavailable: ${f.historyError}</p>` : ""}
      </div>`)
    .join("");

  snapshot.funds.forEach((f) => {
    if (!f.priceHistory || f.priceHistory.length === 0) return;
    renderChart(`hist-${f.code}`, {
      type: "line",
      data: {
        labels: f.priceHistory.map((p) => new Date(p.date).toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit" })),
        datasets: [
          {
            label: f.code,
            data: f.priceHistory.map((p) => p.price),
            borderColor: "#2563eb",
            backgroundColor: "rgba(37,99,235,0.1)",
            fill: true,
            tension: 0.25,
            pointRadius: 0,
          },
        ],
      },
      options: {
        plugins: { legend: { display: false } },
        scales: { x: { ticks: { maxTicksLimit: 6 } } },
      },
    });
  });
}

// ---- Fund sector & holdings tab ----------------------------------------

function renderFundDetails(snapshot) {
  const grid = document.getElementById("fund-details-grid");
  grid.innerHTML = snapshot.funds
    .map((f) => {
      const holdingsHtml = f.holdings && f.holdings.ok
        ? `<ul class="holdings-list">${f.holdings.holdings
            .map((h) => `<li><span>${h.ticker}</span><span>${h.percent.toFixed(2)}%</span></li>`)
            .join("")}</ul>`
        : `<p class="holdings-unavailable">Individual share holdings unavailable${f.holdings?.error ? ` (${f.holdings.error})` : ""}. See <a href="${f.holdings?.url || "#"}" target="_blank" rel="noopener">Fintables</a>.</p>`;

      return `<div class="fund-card">
        <h3>${f.label}</h3>
        <span class="fund-code">${f.code} &middot; allocation as of ${fmtDate(f.allocationAsOf)}</span>
        <canvas id="alloc-${f.code}" height="180"></canvas>
        <h4 style="margin:14px 0 4px;font-size:0.85rem;color:var(--muted)">Top equity holdings (Fintables)</h4>
        ${holdingsHtml}
      </div>`;
    })
    .join("");

  snapshot.funds.forEach((f) => {
    if (!f.allocation || f.allocation.length === 0) return;
    renderChart(`alloc-${f.code}`, {
      type: "pie",
      data: {
        labels: f.allocation.map((s) => s.label),
        datasets: [
          {
            data: f.allocation.map((s) => s.percent),
            backgroundColor: f.allocation.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
          },
        ],
      },
      options: {
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 10 } } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${ctx.parsed.toFixed(1)}%` } },
        },
      },
    });
  });
}

// ---- Orchestration ------------------------------------------------------

let firstLoadSucceeded = false;

async function loadPortfolio() {
  const errorBanner = document.getElementById("dashboard-error");
  try {
    const res = await fetch("/api/portfolio");
    if (res.status === 503 && !firstLoadSucceeded) {
      // Expected right after the server starts: TEFAS is rate-limited to a
      // handful of requests/minute, so the very first refresh across a
      // full portfolio can take a few minutes. Not an error yet.
      errorBanner.hidden = false;
      errorBanner.className = "warning-banner";
      errorBanner.textContent = "Loading your portfolio for the first time — TEFAS's rate limit means this can take a few minutes. This page updates automatically once it's ready.";
      return;
    }
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    const snapshot = await res.json();

    firstLoadSucceeded = true;
    errorBanner.hidden = true;
    errorBanner.className = "error-banner";
    renderSummary(snapshot);
    renderAllocationChart(snapshot);
    renderProfitChart(snapshot);
    renderHoldingsTable(snapshot);
    renderFundHistoryGrid(snapshot);
    renderFundDetails(snapshot);
  } catch (err) {
    errorBanner.hidden = false;
    errorBanner.className = "error-banner";
    errorBanner.textContent = `Couldn't load portfolio data: ${err.message}`;
  }
}

async function loadStatus() {
  try {
    const res = await fetch("/api/status");
    const status = await res.json();
    const line = document.getElementById("status-line");
    line.textContent = status.portfolioUpdatedAt
      ? `Last updated ${new Date(status.portfolioUpdatedAt).toLocaleTimeString("tr-TR")}`
      : "Waiting for first update…";
  } catch {
    /* status line is a convenience only */
  }
}

async function refreshAll() {
  await Promise.all([loadPortfolio(), loadMarket(), loadStatus()]);
}

document.getElementById("refresh-btn").addEventListener("click", async () => {
  await fetch("/api/refresh", { method: "POST" });
  await refreshAll();
});

refreshAll();
setInterval(loadMarket, 30 * 1000);
setInterval(loadStatus, 30 * 1000);

// Poll quickly until the first refresh lands (it can take a few minutes
// due to TEFAS's rate limit), then settle into the normal slow cadence —
// no point hammering the server once the portfolio has loaded.
(function pollPortfolio() {
  const delay = firstLoadSucceeded ? 60 * 1000 : 8 * 1000;
  setTimeout(async () => {
    await loadPortfolio();
    pollPortfolio();
  }, delay);
})();
