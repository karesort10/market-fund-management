# Fund & Market Dashboard

A small, locally-hosted dashboard for tracking a portfolio of Turkish
mutual funds (TEFAS-listed). It shows current value, profit/loss, a
per-fund price chart, a portfolio allocation pie chart, a tab for each
fund's sector composition and underlying holdings, buy/sell trading with
a cash balance, and a news + optional AI market-analysis tab.

## What it does

- **Portfolio tab**
  - Total value / cost / profit (₺ and %)
  - Doughnut chart of portfolio allocation by fund
  - Bar chart of profit/loss by fund
  - Holdings table (quantity, avg. cost, current price, value, P/L)
  - A price-history line chart for each individual fund
  - A small market ticker (BIST 100, USD/TRY, EUR/TRY, gold) for general
    market context
- **Fund Sector & Holdings tab**
  - Each fund's asset-class breakdown (stocks / bonds / gold / repo / etc.)
    as a pie chart, sourced from TEFAS
  - Each fund's top underlying equities (e.g. which BIST stocks a fund
    holds), sourced from Fintables, when available
- **Trade tab** — buy or sell a fund by its TEFAS code. Buying a code you
  don't already hold adds it to your portfolio automatically (its real
  name fills in once TEFAS resolves it); selling consumes your oldest
  purchases first (FIFO) and reports realized profit/loss.
- **Balance tab** — cash balance, total funds value, and net worth;
  deposit or withdraw cash (buying a fund draws from this balance,
  selling credits back to it); full transaction history.
- **News & Insights tab** — headlines aggregated from trusted financial
  outlets, an optional AI market-analysis summary, and a prominent
  critical-warnings section for conflicts or major news relevant to the
  specific sectors your funds are actually exposed to. See below — this
  part is opt-in and costs a small amount of money if enabled.

## Data sources

| Source | Used for | Reliability |
|---|---|---|
| [TEFAS](https://www.tefas.gov.tr) `api/funds/fonGnlBlgSiraliGetir` / `dagilimSiraliGetirT` | Fund NAV history, asset-class allocation | TEFAS retired its older `BindHistoryInfo`/`BindHistoryAllocation` API in 2026; this uses the JSON gateway that replaced it (undocumented officially, but the same one actively-maintained community TEFAS clients use). No API key, but **rate-limited to roughly 6 requests/minute** — see below. |
| [Yahoo Finance](https://finance.yahoo.com) chart API | BIST 100 / USDTRY / EURTRY / gold ticker | Public, unauthenticated, widely used. |
| [Fintables](https://fintables.com) fund pages | Individual equity holdings per fund | **Best effort, and often blocked.** TEFAS's API publishes only asset-*class* percentages (stocks 80%, repo 20%), never the individual stock names, so this is the only route to "which shares does my fund actually hold" — and it means scraping, since Fintables has no public API. Fintables frequently answers automated requests with **HTTP 403**; when that happens the UI says so per fund and links to the page so you can read it directly. Everything else on that tab still works. |
| Bloomberg HT, Dünya Gazetesi, Anadolu Ajansı, Investing.com (RSS) | News tab headlines | Public RSS feeds, no API key. A feed that's down or has moved is dropped from the merged list rather than failing the whole News tab — see `src/services/news.js` if a source stops showing up. |
| Anthropic API (Claude) | Optional AI market analysis | Opt-in, requires your own `ANTHROPIC_API_KEY` — see **AI market analysis** below. |

TEFAS publishes fund prices **once per trading day** (after markets
close), so "real-time" for fund NAVs means "refreshed as often as TEFAS
actually updates it and its rate limit allows", not tick-by-tick. The
market ticker (index/FX/gold) does update intraday.

### TEFAS's rate limit and the first load

TEFAS's API allows roughly 6 requests/minute. Every fund needs 2 requests
(price + allocation), so a portfolio of N funds takes about `N × 20`
seconds to fully refresh — e.g. ~4 minutes for 11 funds. All requests are
queued through a single throttle app-wide, so this happens automatically
and never bursts past that pace.

**This means the first load after starting the server can take a few
minutes.** During that window `/api/portfolio` returns `503` and the
dashboard shows an amber "Loading your portfolio for the first time…"
banner (polling every 8s) rather than data — this is expected, not a bug.
Once the first refresh completes it switches to the normal 10-minute
background refresh cycle and polls that every 60s.

## Setup

Requires Node.js 18+ (uses the built-in `fetch`).

```bash
npm install
npm start
```

Then open http://localhost:3000.

By default the server listens on port 3000. Override with `PORT=4000 npm start`.

## Configuring your holdings

Edit `data/portfolio.json`. Each fund has a TEFAS code and one or more
purchase "lots" (so averaging cost across multiple buys works correctly):

```json
{
  "currency": "TRY",
  "funds": [
    {
      "code": "AFA",
      "label": "Ak Portföy Amerika Yabancı BYF Fon Sepeti Fonu",
      "lots": [
        { "date": "2026-02-10", "quantity": 500, "price": 11.20 },
        { "date": "2026-05-03", "quantity": 300, "price": 12.85 }
      ]
    }
  ]
}
```

- `code`: the fund's TEFAS code (shown on tefas.gov.tr and Fintables URLs).
- `label`: optional display name; falls back to TEFAS's fund title if omitted.
- `lots`: every purchase, quantity (units) and price paid per unit.

The server re-reads this file on every scheduled refresh, so changes take
effect within one refresh cycle (or immediately via the "Refresh now"
button).

## Trading and cash balance

Use the **Trade** tab instead of hand-editing `portfolio.json` once you're
up and running — buying/selling writes to the same file, so both stay in
sync. Deposit cash in the **Balance** tab before buying (buying validates
you have enough cash; there's no implicit "infinite money"). Every trade
and balance change is logged in `transactions` and shown in the Balance
tab's history, including realized profit/loss on sells.

A trade or balance change updates the dashboard within a few seconds if
the portfolio has already loaded once — it reuses already-fetched TEFAS
data for funds you already hold rather than waiting through the rate
limit again, and only does a real (fast, single-fund) TEFAS fetch for a
brand-new fund code. Right at server startup, before the first load has
completed at all, a trade is still saved instantly but the dashboard
won't reflect it until that initial load finishes.

## News & AI market analysis

The **News & Insights** tab always shows headlines (free, no setup). The
AI analysis part of that tab — a plain-language market summary, short
per-sector predictions, and a critical-warnings box for conflicts or
major news relevant to *your specific funds* — is entirely optional and
disabled by default.

### How to turn it on (step by step)

1. **Get a key**: go to **[console.anthropic.com](https://console.anthropic.com)**, sign up or log in, then open **Settings → API Keys** (or **Get API keys** on the dashboard) and click **Create Key**. Copy the key it shows you (starts with `sk-ant-...`) — you won't be able to see it again after leaving the page, so copy it now.
2. You'll also need a payment method on that account (**Settings → Billing**) — this key is billed to *your* Anthropic account, separately from this app. See the cost estimate below before adding one; it's small, but it's real money.
3. In this project's folder, copy the example env file:
   ```bash
   cp .env.example .env
   ```
4. Open `.env` in any text editor and paste your key after the `=`, so the line reads:
   ```
   ANTHROPIC_API_KEY=sk-ant-your-actual-key-here
   ```
   Save the file. (`.env` is already excluded from git via `.gitignore`, so this key never gets committed or pushed anywhere.)
5. Restart the server (`npm start`). The terminal should print `AI market analysis enabled` on startup — if it instead prints `AI market analysis disabled`, the key wasn't picked up; double check the `.env` file is in the project's root folder (next to `package.json`) and the variable name is spelled exactly `ANTHROPIC_API_KEY`.
6. Open the **News & Insights** tab — either wait for the first automatic analysis (~30 seconds after startup) or click **Analyze now**.

**Cost**: this calls Claude (Haiku, Anthropic's cheapest model) with your
fund list and recent headlines, capped at ~1000 output tokens per call.
Left on its default schedule (every 6 hours, configurable via
`AI_REFRESH_MS`), that's 4 calls/day — a small fraction of a cent each,
so well under $1/month at default cost as of this writing. Clicking
"Analyze now" runs one extra call on demand. Every other feature in this
app (TEFAS, Yahoo Finance, Fintables, RSS) is completely free — this is
the only paid piece, billed to your own Anthropic account, and the app
works fully without it (that tab just shows a "not configured" message
in the AI section, headlines still work).

This is a convenience summary of public headlines, not financial advice,
and the model can be wrong — treat predictions and warnings as a prompt
to go read the news yourself, not as a signal to act on directly.

## Refresh intervals

Configurable via environment variables:

```bash
PORTFOLIO_REFRESH_MS=300000 MARKET_REFRESH_MS=60000 NEWS_REFRESH_MS=1800000 AI_REFRESH_MS=21600000 npm start
```

## Notes / limitations

- This is a personal, single-user local tool — there's no authentication,
  and it's meant to be run on `localhost`, not exposed to the internet.
- TEFAS's allocation endpoint doesn't have a fixed, documented column list
  across every fund type, so the allocation chart dynamically shows
  whatever asset-class percentages TEFAS returns for a given fund, rather
  than hardcoding category names.
- If a request to TEFAS, Yahoo Finance, or Fintables fails (network issue,
  changed API), that one panel shows an "unavailable" message instead of
  taking down the rest of the dashboard.
- **Fund Sector & Holdings tab.** The pie chart (asset classes) comes from
  TEFAS; the equity list under it comes from Fintables and is the part
  most likely to read "unavailable: HTTP 403" — see the data-sources table
  above. Both now state the specific reason rather than rendering blank.
  Asset allocation and holdings are re-fetched at most once every 12 hours
  (they change on the order of weeks, unlike prices), so they don't slow
  down every refresh cycle; a *failed* fetch is never cached, so it retries
  on the next cycle rather than staying broken for half a day.
- Chart.js is served locally from `node_modules` rather than a CDN, so the
  dashboard works offline and isn't broken by ad blockers. If the charting
  library ever fails to load anyway, each chart degrades to a short note
  and the surrounding tables/lists still render.
