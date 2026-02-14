# CLAUDE.md — Project Instructions for Claude Code

## What This App Does

Shopify embedded app that pulls data from three sources — **Shopify** (orders, products), **Google Analytics 4** (sessions, bounce rate), and **Meta Ads** (spend, ROAS, conversions) — then generates AI-powered business insights via **Claude AI** and displays them as a tile-based dashboard inside Shopify Admin.

## Tech Stack

- **Runtime:** Node.js 18+ (no build step)
- **Framework:** Express.js 4.x
- **AI:** Claude Sonnet 4.5 via `@anthropic-ai/sdk`
- **Analytics:** Google Analytics Data API v1beta via `googleapis`
- **Ads:** Meta Graph API v18.0 (direct HTTP fetch)
- **Auth:** Shopify OAuth 2.0, express-session
- **Deploy:** Railway (Nixpacks builder)
- **Frontend:** Server-rendered HTML (no React/Vue/SPA — all HTML templates in server.js)

## File Structure

```
shopify-dashboard-app/
├── server.js          # Entire application — routes, API clients, HTML builders
├── package.json       # Dependencies and scripts
├── package-lock.json  # Lockfile
├── railway.json       # Railway deployment config (Nixpacks, health check)
├── .env               # Real credentials (gitignored)
├── .env.example       # Template with all env vars documented
├── .gitignore         # node_modules, .env, .DS_Store, logs
├── CLAUDE.md          # This file
└── README.md          # Setup and deployment guide
```

Everything lives in `server.js` (~1,330 lines). It's a monolith by design — simple enough that splitting into modules isn't necessary yet.

## Architecture & Data Flow

### Authentication Methods

| Source | Auth Method | Details |
|--------|-----------|---------|
| Shopify | OAuth 2.0 | Standard Shopify app OAuth flow. Token stored in-memory (`shopTokens` map). Scopes: `read_products,read_orders` |
| Google Analytics | Service Account | JSON key stored as env var. No user-facing OAuth needed. SA email must be added as viewer on GA property |
| Meta Ads | System User Token | Permanent token from Meta Business Suite. No OAuth flow needed. Stored as env var |
| Claude AI | API Key | Standard Anthropic API key from console.anthropic.com |

### Request Flow (Dashboard)

1. User opens app in Shopify Admin → iframe loads `/?shop=xxx`
2. If no token → redirect to `/install` → Shopify OAuth → `/auth/callback` → token saved
3. `/dashboard?shop=xxx` → check 24hr cache → if miss:
   a. Fetch order count + 250-order sample from Shopify API
   b. Extract top products by revenue and units from order line items
   c. Fetch GA4 metrics (sessions, bounce rate, page views, users)
   d. Fetch Meta Ads insights (spend, impressions, clicks, purchases, revenue, ROAS)
   e. Send all data to Claude with structured prompt → parse 4-5 tile response
   f. Cache result for 24 hours
4. Render server-side HTML with tile grid, freshness cards, and dynamic colors

### Routes

| Route | Purpose |
|-------|---------|
| `GET /` | Entry point — redirects to dashboard or install |
| `GET /install` | OAuth landing page (runs outside iframe) |
| `GET /auth` | Start Shopify OAuth flow |
| `GET /auth/callback` | Complete Shopify OAuth, save token |
| `GET /dashboard` | Main dashboard with AI insight tiles |
| `GET /insights` | JSON API for insights (used by client-side JS, if any) |
| `GET /settings` | Data source connection status cards |
| `GET /disconnect` | Remove shop token and clear cache |
| `GET /test-ga` | Debug endpoint to verify GA connection |
| `GET /health` | Health check for Railway |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SHOPIFY_API_KEY` | Yes | From Shopify Partners dashboard. App crashes without it |
| `SHOPIFY_API_SECRET` | Yes | From Shopify Partners dashboard. App crashes without it |
| `HOST` | Yes | Public URL (e.g. `https://your-app.up.railway.app`). No trailing slash. Used for OAuth redirect URI |
| `PORT` | No | Server port. Defaults to 3000. Railway sets this automatically |
| `NODE_ENV` | No | Set to `production` on Railway for secure cookies and trust proxy |
| `APP_HANDLE` | No | Shopify app handle from Partners dashboard. Defaults to `mr-bean`. Used for admin redirect after OAuth |
| `META_SYSTEM_USER_TOKEN` | No | Permanent token from Meta Business Suite System User. Needs `ads_read` permission |
| `META_AD_ACCOUNT_ID` | No | Meta ad account ID. Code auto-prepends `act_` if missing |
| `GA_PROPERTY_ID` | No | GA4 property ID (numeric, e.g. `401381070`) |
| `GA_SERVICE_ACCOUNT_JSON` | No | Entire JSON key file as a single-line string. SA email must be viewer on GA property |
| `ANTHROPIC_API_KEY` | No | From console.anthropic.com. Without it, dashboard shows setup prompt instead of tiles |
| `SESSION_SECRET` | No | Auto-generated if not set. Used for express-session |

## Caching System

- In-memory cache keyed by shop domain (`insightsCache`)
- 24-hour TTL (`INSIGHTS_TTL = 86400000ms`)
- Force refresh via `?refresh=1` query param on dashboard
- Cache stores: tiles, shopifyStats, gaData, metaAdsData, generatedAt timestamp
- Cache is cleared when shop disconnects (`deleteShopToken`)
- **Important:** In-memory cache is lost on Railway redeploy. This is fine — insights regenerate on next visit

## Design Principles

- **Conversational tone, not dashboard-speak.** Claude prompt uses "you" and "your", writes like a sharp advisor texting a store owner. No corporate buzzwords
- **Tile-based layout** with 4-5 cards:
  - **Health Check** (full-width) — status emoji + 3 key metrics with improvement actions
  - **Biggest Issue** — always red, blunt, names the £ impact
  - **Quick Win** — always blue, one specific action for this week
  - **Opportunity** — always yellow, growth pattern with £ potential
  - **Ad Performance** — only when Meta data available, color based on ROAS thresholds
- **Dynamic tile colors** reflect severity: green (healthy), yellow (warning), red (critical), blue (action)
- **Emoji as visual indicators**, not decoration: 📈📉 trends, 💰 money, ⚠️ problems, ✅ wins, 🎯 actions
- **Specific product/brand callouts** — top 3 products by revenue and units are passed to Claude. Prompt says "never say 'your products' — name them"
- **Never overwhelming** — strict word limits per tile (30-40 words), every sentence must be actionable or data-driven
- **Always show improvement path** — every positive must include "but here's how to go further". Format: `[Current state] → [Action] = [Expected result]`

## Known Constraints

- **Shopify iframe blocks redirects:** The app runs inside Shopify Admin's iframe. OAuth redirects and external auth flows can't happen inside the iframe — they need `X-Frame-Options: DENY` to break out, or use `target="_top"` links
- **24hr cache controls Claude API costs:** Each insight generation is one Claude API call. The 24hr cache ensures costs stay predictable. Users can force refresh with the Refresh button
- **In-memory token store:** Shop tokens and cache are stored in-memory. A Railway redeploy clears them — shops need to re-authenticate. For production scale, migrate to Redis or PostgreSQL
- **Meta Ads uses System User tokens:** Originally used OAuth popup flow, now uses permanent System User tokens from Meta Business Suite. No per-user auth needed — the token is an env var
- **250-order sample limit:** Shopify API returns max 250 orders per request. Order count is exact (via count endpoint), but AOV is calculated from the 250-order sample. Revenue is estimated when total orders > 250

## Running Locally

```bash
cp .env.example .env    # Fill in credentials
npm install
npm run dev             # node --watch server.js
```

Then open `http://localhost:3000/install` and enter your `.myshopify.com` domain.

## Deploying to Railway

1. Push to GitHub
2. Connect repo in Railway dashboard
3. Set all env vars (especially `HOST`, `NODE_ENV=production`)
4. Railway auto-detects Node.js via Nixpacks, runs `npm start`
5. Health check at `/health` is configured in `railway.json`
