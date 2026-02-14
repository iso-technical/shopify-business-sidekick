# Shopify Dashboard App

AI-powered business insights dashboard for Shopify stores. Pulls data from Shopify, Google Analytics, and Meta Ads, then uses Claude AI to generate actionable tile-based insights displayed inside Shopify Admin.

## Prerequisites

- Node.js 18+
- A Shopify Partners account with an app created
- (Optional) Google Analytics 4 property with a service account
- (Optional) Meta Business Suite with a System User token
- (Optional) Anthropic API key for Claude AI insights

## Quick Start

```bash
git clone <repo-url>
cd shopify-dashboard-app
cp .env.example .env   # Edit with your credentials
npm install
npm run dev            # Starts with --watch for auto-reload
```

Open `http://localhost:3000/install` and enter your `store.myshopify.com` domain.

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|----------|----------|-------------|
| `SHOPIFY_API_KEY` | Yes | App API key from Shopify Partners |
| `SHOPIFY_API_SECRET` | Yes | App API secret from Shopify Partners |
| `HOST` | Yes | Public URL of your app (no trailing slash) |
| `APP_HANDLE` | No | App handle from Partners (default: `mr-bean`) |
| `META_SYSTEM_USER_TOKEN` | No | Permanent token from Meta Business Suite System User |
| `META_AD_ACCOUNT_ID` | No | Meta ad account ID (auto-prepends `act_` if needed) |
| `GA_PROPERTY_ID` | No | GA4 property ID (numeric) |
| `GA_SERVICE_ACCOUNT_JSON` | No | Full service account JSON key as single-line string |
| `ANTHROPIC_API_KEY` | No | Claude API key from console.anthropic.com |
| `SESSION_SECRET` | No | Auto-generated if not set |
| `PORT` | No | Default: 3000 |
| `NODE_ENV` | No | Set to `production` for secure cookies |

### Setting Up Data Sources

**Shopify** (required): Create an app in Shopify Partners, copy the API key and secret. Set the redirect URL to `{HOST}/auth/callback`.

**Google Analytics**: Create a service account in Google Cloud Console, enable the GA4 Data API, download the JSON key, and add the service account email as a Viewer on your GA4 property.

**Meta Ads**: In Meta Business Suite > Business Settings, create a System User with `ads_read` permission and generate a permanent token. No OAuth flow needed.

**Claude AI**: Get an API key from console.anthropic.com. Without it, the dashboard shows a setup prompt instead of insights.

## Deploy to Railway

1. Push your repo to GitHub
2. Create a new project in [Railway](https://railway.app)
3. Connect your GitHub repo
4. Add all environment variables (set `NODE_ENV=production` and `HOST` to your Railway URL)
5. Railway auto-detects Node.js and runs `npm start`

The `railway.json` configures Nixpacks build, health check at `/health`, and restart-on-failure.

## Architecture

Single-file Express app (`server.js`) with server-rendered HTML. No frontend build step.

**Data flow:** Shopify OAuth > Fetch orders + GA + Meta Ads > Claude generates insight tiles > Cached 24hrs > Rendered as HTML

**Dashboard tiles:**
- Health Check (dynamic green/yellow/red)
- Biggest Issue (always red)
- Quick Win (always blue)
- Opportunity (always yellow)
- Ad Performance (when Meta data available, color by ROAS)

## Scripts

- `npm start` — Production server
- `npm run dev` — Development with auto-reload (`--watch`)
