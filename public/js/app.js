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
  // A chart that can't be drawn must never take the rest of the page with
  // it: every panel here renders text (holdings, prices, error reasons)
  // alongside its chart, and callers render many charts in a loop, so one
  // throw used to abort the whole dashboard render.
  try {
    if (typeof Chart === "undefined") throw new Error("charting library failed to load");
    if (charts[canvasId]) charts[canvasId].destroy();
    charts[canvasId] = new Chart(el, config);
  } catch (err) {
    const note = document.createElement("p");
    note.className = "holdings-unavailable";
    note.textContent = `Chart unavailable: ${err.message}`;
    el.replaceWith(note);
  }
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
  // When every fund fails the same way, that's one systemic cause (a
  // blocked source), not 11 separate problems — say it once, clearly,
  // instead of repeating a bare "HTTP 403" on every card.
  const notice = document.getElementById("details-notice");
  const withHoldings = snapshot.funds.filter((f) => f.holdings?.ok).length;
  if (snapshot.funds.length > 0 && withHoldings === 0) {
    const reason = snapshot.funds[0]?.holdings?.error || "";
    notice.hidden = false;
    notice.innerHTML = /40[13]/.test(reason)
      ? `<strong>Individual stock holdings are unavailable.</strong> Fintables (the only source that publishes which
         shares each fund holds) is refusing automated requests with <code>${reason}</code>. This is bot protection on
         their side, not a bug in your setup, and it can't be worked around from a plain script.
         The asset-class breakdown below still comes from TEFAS and is unaffected — and each fund links to its
         Fintables page, which opens fine in a normal browser.`
      : `<strong>Individual stock holdings are unavailable</strong> for every fund (${reason}). The asset-class
         breakdown below still comes from TEFAS and is unaffected.`;
  } else {
    notice.hidden = true;
  }

  const grid = document.getElementById("fund-details-grid");
  grid.innerHTML = snapshot.funds
    .map((f) => {
      const hasAllocation = f.allocation && f.allocation.length > 0;
      const allocationHtml = hasAllocation
        ? `<span class="fund-code">${f.code} &middot; allocation as of ${fmtDate(f.allocationAsOf)}</span>
           <canvas id="alloc-${f.code}" height="180"></canvas>`
        : `<span class="fund-code">${f.code}</span>
           <p class="holdings-unavailable">Asset allocation unavailable${f.allocationError ? `: ${f.allocationError}` : " (TEFAS returned no breakdown for this fund)."}</p>`;

      const holdingsHtml = f.holdings && f.holdings.ok
        ? `<ul class="holdings-list">${f.holdings.holdings
            .map((h) => `<li><span>${h.ticker}</span><span>${h.percent.toFixed(2)}%</span></li>`)
            .join("")}</ul>`
        : `<p class="holdings-unavailable">Not available${f.holdings?.error ? ` (${f.holdings.error})` : ""} — <a href="${f.holdings?.url || "#"}" target="_blank" rel="noopener">view on Fintables</a>.</p>`;

      return `<div class="fund-card">
        <h3>${f.label}</h3>
        ${allocationHtml}
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

// ---- Balance & transactions ---------------------------------------------

function renderBalance(snapshot) {
  const { balance, currency } = snapshot;
  if (!balance) return;
  document.getElementById("balance-cash").textContent = fmtMoney(balance.cash, currency);
  document.getElementById("balance-funds").textContent = fmtMoney(balance.fundsValue, currency);
  document.getElementById("balance-networth").textContent = fmtMoney(balance.netWorth, currency);
}

const TX_TYPE_LABELS = { buy: "Buy", sell: "Sell", deposit: "Deposit", withdraw: "Withdraw" };

function renderTransactions(snapshot) {
  const tbody = document.querySelector("#transactions-table tbody");
  const transactions = snapshot.transactions || [];
  if (transactions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="holdings-unavailable">No transactions yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = transactions
    .map((t) => {
      const plCell =
        t.realizedPL == null ? "—" : `<span class="${t.realizedPL >= 0 ? "positive" : "negative"}">${fmtMoney(t.realizedPL, snapshot.currency)}</span>`;
      return `<tr>
        <td>${fmtDate(t.date)}</td>
        <td>${TX_TYPE_LABELS[t.type] || t.type}</td>
        <td>${t.code || "—"}</td>
        <td>${t.quantity != null ? t.quantity.toLocaleString("tr-TR") : "—"}</td>
        <td>${t.price != null ? fmtMoney(t.price, snapshot.currency) : "—"}</td>
        <td>${fmtMoney(t.amount, snapshot.currency)}</td>
        <td>${plCell}</td>
        <td>${t.note || "—"}</td>
      </tr>`;
    })
    .join("");
}

// ---- Trade & balance forms ------------------------------------------------

document.getElementById("trade-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("trade-message");
  msg.textContent = "Submitting…";
  msg.className = "form-message";

  const body = {
    action: document.getElementById("trade-action").value,
    code: document.getElementById("trade-code").value,
    quantity: document.getElementById("trade-quantity").value,
    price: document.getElementById("trade-price").value,
    date: document.getElementById("trade-date").value || undefined,
  };

  try {
    const res = await fetch("/api/trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    msg.textContent = `${body.action === "buy" ? "Bought" : "Sold"} ${body.quantity} ${body.code.toUpperCase()} @ ${body.price}.`;
    msg.className = "form-message success";
    document.getElementById("trade-form").reset();
    renderAllFromSnapshot(data.portfolio);
  } catch (err) {
    msg.textContent = err.message;
    msg.className = "form-message error";
  }
});

document.getElementById("balance-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("balance-message");
  msg.textContent = "Submitting…";
  msg.className = "form-message";

  const body = {
    action: document.getElementById("balance-action").value,
    amount: document.getElementById("balance-amount").value,
    note: document.getElementById("balance-note").value || undefined,
  };

  try {
    const res = await fetch("/api/balance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    msg.textContent = `${body.action === "deposit" ? "Deposited" : "Withdrew"} ${body.amount}.`;
    msg.className = "form-message success";
    document.getElementById("balance-form").reset();
    renderAllFromSnapshot(data.portfolio);
  } catch (err) {
    msg.textContent = err.message;
    msg.className = "form-message error";
  }
});

function renderAllFromSnapshot(snapshot) {
  if (!snapshot) return;
  renderSummary(snapshot);
  renderAllocationChart(snapshot);
  renderProfitChart(snapshot);
  renderHoldingsTable(snapshot);
  renderFundHistoryGrid(snapshot);
  renderFundDetails(snapshot);
  renderBalance(snapshot);
  renderTransactions(snapshot);
}

// ---- News & AI insights ---------------------------------------------------

function renderNews(data) {
  const list = document.getElementById("news-list");
  const articles = data.articles || [];
  if (articles.length === 0) {
    list.innerHTML = `<p class="holdings-unavailable">No headlines available right now.</p>`;
  } else {
    list.innerHTML = articles
      .slice(0, 40)
      .map(
        (a) => `<div class="news-item">
          <a href="${a.link}" target="_blank" rel="noopener">${a.title}</a>
          <div class="news-meta">${a.source}${a.publishedAt ? " · " + new Date(a.publishedAt).toLocaleString("tr-TR") : ""}</div>
          ${a.summary ? `<div class="news-summary">${a.summary}</div>` : ""}
        </div>`
      )
      .join("");
  }
  if (data.sourceErrors && data.sourceErrors.length > 0) {
    list.innerHTML += `<p class="holdings-unavailable">Unavailable right now: ${data.sourceErrors.map((e) => e.source).join(", ")}.</p>`;
  }
}

function renderInsights(data) {
  const body = document.getElementById("insights-body");
  const warningsBox = document.getElementById("warnings-box");
  const warningsList = document.getElementById("warnings-list");
  const analyzeBtn = document.getElementById("analyze-btn");

  if (!data.available) {
    body.innerHTML = `<p class="hint">AI analysis isn't set up. Set the <code>ANTHROPIC_API_KEY</code> environment variable and restart the server to enable it — see the README for cost details. It's entirely optional.</p>`;
    warningsBox.hidden = true;
    analyzeBtn.disabled = true;
    return;
  }

  analyzeBtn.disabled = false;

  if (data.error) {
    body.innerHTML = `<p class="holdings-unavailable">AI analysis failed: ${data.error}</p>`;
    warningsBox.hidden = true;
    return;
  }

  const predictionsHtml = (data.predictions || [])
    .map((p) => `<li><span class="prediction-topic">${p.topic}:</span> ${p.outlook}</li>`)
    .join("");

  body.innerHTML = `
    <p>${data.marketSummary || "No summary available yet."}</p>
    ${predictionsHtml ? `<ul class="predictions-list">${predictionsHtml}</ul>` : ""}
    <p class="ai-disclaimer">AI-generated from public headlines — not financial advice, and may be wrong. Last analyzed: ${data.generatedAt ? new Date(data.generatedAt).toLocaleString("tr-TR") : "—"}.</p>
  `;

  const warnings = data.warnings || [];
  if (warnings.length > 0) {
    warningsBox.hidden = false;
    warningsList.innerHTML = warnings
      .map(
        (w) => `<div class="warning-item">
          <span class="severity-badge severity-${w.severity || "medium"}">${w.severity || "medium"}</span>
          <span class="warning-sector">${w.sector}:</span> ${w.message}
        </div>`
      )
      .join("");
  } else {
    warningsBox.hidden = true;
  }
}

async function loadNews() {
  try {
    const res = await fetch("/api/news");
    renderNews(await res.json());
  } catch {
    document.getElementById("news-list").innerHTML = `<p class="holdings-unavailable">News unavailable.</p>`;
  }
}

async function loadInsights() {
  try {
    const res = await fetch("/api/insights");
    renderInsights(await res.json());
  } catch {
    document.getElementById("insights-body").innerHTML = `<p class="holdings-unavailable">AI analysis unavailable.</p>`;
  }
}

document.getElementById("analyze-btn").addEventListener("click", async () => {
  const btn = document.getElementById("analyze-btn");
  btn.disabled = true;
  btn.textContent = "Analyzing…";
  try {
    const res = await fetch("/api/insights/refresh", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderInsights(data.insights);
  } catch (err) {
    document.getElementById("insights-body").innerHTML = `<p class="holdings-unavailable">${err.message}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Analyze now";
  }
});

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
    renderAllFromSnapshot(snapshot);
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
  await Promise.all([loadPortfolio(), loadMarket(), loadStatus(), loadNews(), loadInsights()]);
}

document.getElementById("refresh-btn").addEventListener("click", async () => {
  await fetch("/api/refresh", { method: "POST" }); // never triggers the paid AI analysis, see server.js
  await refreshAll();
});

refreshAll();
setInterval(loadMarket, 30 * 1000);
setInterval(loadStatus, 30 * 1000);
setInterval(loadNews, 5 * 60 * 1000);
setInterval(loadInsights, 5 * 60 * 1000); // just re-reads the cache; AI itself only (re)runs server-side on its own slow schedule or "Analyze now"

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
