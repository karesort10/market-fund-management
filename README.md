# Fund & Market Dashboard

A small, locally-hosted dashboard for tracking a portfolio of Turkish
mutual funds (TEFAS-listed). It shows current value, profit/loss, a
per-fund price chart, a portfolio allocation pie chart, and a second tab
with each fund's asset-class composition and (best effort) underlying
equity holdings.

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

## Data sources

| Source | Used for | Reliability |
|---|---|---|
| [TEFAS](https://www.tefas.gov.tr) `api/funds/fonGnlBlgSiraliGetir` / `dagilimSiraliGetirT` | Fund NAV history, asset-class allocation | TEFAS retired its older `BindHistoryInfo`/`BindHistoryAllocation` API in 2026; this uses the JSON gateway that replaced it (undocumented officially, but the same one actively-maintained community TEFAS clients use). No API key, but **rate-limited to roughly 6 requests/minute** — see below. |
| [Yahoo Finance](https://finance.yahoo.com) chart API | BIST 100 / USDTRY / EURTRY / gold ticker | Public, unauthenticated, widely used. |
| [Fintables](https://fintables.com) fund pages | Individual equity holdings per fund | **Best effort.** Fintables has no documented public API, so this scrapes the rendered page. If Fintables changes their markup, this can stop finding data — the UI will show "unavailable" instead of breaking, and a link to the page is always shown as a fallback. |

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

## Refresh intervals

Configurable via environment variables:

```bash
PORTFOLIO_REFRESH_MS=300000 MARKET_REFRESH_MS=60000 npm start
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
