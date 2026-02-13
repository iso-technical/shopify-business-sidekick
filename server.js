require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const session = require("express-session");

const app = express();
const PORT = process.env.PORT || 3000;

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SCOPES = "read_products,read_orders";
const HOST = process.env.HOST; // e.g. https://your-app.up.railway.app
const APP_HANDLE = process.env.APP_HANDLE || "mr-bean";
const GA_PROPERTY_ID = process.env.GA_PROPERTY_ID;
const GA_SERVICE_ACCOUNT_JSON = process.env.GA_SERVICE_ACCOUNT_JSON;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const META_SYSTEM_USER_TOKEN = process.env.META_SYSTEM_USER_TOKEN;
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID;

if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
  console.error("Missing SHOPIFY_API_KEY or SHOPIFY_API_SECRET env vars");
  process.exit(1);
}

// In-memory token store keyed by shop domain
// Persists across standalone OAuth and embedded iframe requests
// In production, replace with a database (Redis, PostgreSQL, etc.)
const shopTokens = {};

function getShopToken(shop) {
  return shopTokens[shop] || null;
}

function setShopToken(shop, accessToken) {
  shopTokens[shop] = {
    accessToken,
    installedAt: Date.now(),
  };
  console.log("[store] saved token for", shop);
}

function deleteShopToken(shop) {
  delete shopTokens[shop];
  delete insightsCache[shop];
  console.log("[store] deleted token for", shop);
}

// In-memory insights cache keyed by shop domain (24hr TTL)
const insightsCache = {};
const INSIGHTS_TTL = 24 * 60 * 60 * 1000; // 24 hours

function getCachedInsights(shop) {
  const cached = insightsCache[shop];
  if (!cached) return null;
  if (Date.now() - cached.generatedAt > INSIGHTS_TTL) return null;
  return cached;
}

function setCachedInsights(shop, data) {
  insightsCache[shop] = { ...data, generatedAt: Date.now() };
  console.log("[cache] saved insights for", shop);
}

app.use(express.json());
app.use(express.static("public"));

// Trust the reverse proxy (Railway, Heroku, etc.) so req.secure works
// and Express sets Secure cookies behind HTTPS-terminating proxies
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: true,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 3600000, // 1 hour — enough for OAuth flows to complete
    },
  })
);

// CORS — allow fetch requests from Shopify admin iframe
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// Allow Shopify admin to frame this app
app.use((req, res, next) => {
  const shop = req.query.shop;
  if (shop) {
    res.setHeader(
      "Content-Security-Policy",
      `frame-ancestors https://${shop} https://admin.shopify.com; ` +
      `script-src 'self' 'unsafe-inline' https://cdn.shopify.com`
    );
  } else {
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  }
  next();
});

// --- Helpers ---

function buildRedirectUri() {
  return `${HOST}/auth/callback`;
}

function generateNonce() {
  return crypto.randomBytes(16).toString("hex");
}

function verifyHmac(query) {
  const { hmac, ...rest } = query;
  const sorted = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("&");
  const computed = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(sorted)
    .digest("hex");

  console.log("[HMAC] message string:", sorted);
  console.log("[HMAC] received:", hmac);
  console.log("[HMAC] computed:", computed);

  if (Buffer.from(computed).length !== Buffer.from(hmac).length) {
    console.log("[HMAC] length mismatch — received:", hmac.length, "computed:", computed.length);
    return false;
  }

  const match = crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hmac));
  console.log("[HMAC] match:", match);
  return match;
}

async function shopifyFetch(shop, accessToken, endpoint) {
  const [path, query] = endpoint.split("?");
  const url = `https://${shop}/admin/api/2024-01/${path}.json${query ? "?" + query : ""}`;
  const headers = {
    "X-Shopify-Access-Token": accessToken,
    "Content-Type": "application/json",
  };

  console.log("[api] GET", url);
  console.log("[api] token:", accessToken ? accessToken.substring(0, 6) + "..." : "MISSING");

  const res = await fetch(url, { headers });

  console.log("[api] %s → %d", endpoint, res.status);

  if (!res.ok) {
    const errBody = await res.text();
    console.log("[api] error body:", errBody.substring(0, 200));
    throw new Error(`Shopify API error ${res.status}: ${errBody.substring(0, 200)}`);
  }

  return res.json();
}

async function fetchGoogleAnalyticsData() {
  console.log("[ga-auth] GA_PROPERTY_ID:", GA_PROPERTY_ID || "(not set)");
  console.log("[ga-auth] GA_SERVICE_ACCOUNT_JSON exists:", !!GA_SERVICE_ACCOUNT_JSON);
  console.log("[ga-auth] GA_SERVICE_ACCOUNT_JSON length:", GA_SERVICE_ACCOUNT_JSON?.length || 0);

  if (!GA_PROPERTY_ID || !GA_SERVICE_ACCOUNT_JSON) {
    console.log("[ga-auth] aborting — missing config");
    return null;
  }

  const { google } = require("googleapis");

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(GA_SERVICE_ACCOUNT_JSON);
    console.log("[ga-auth] parsed JSON successfully");
    console.log("[ga-auth] client_email:", serviceAccount.client_email || "(missing)");
    console.log("[ga-auth] private_key present:", !!serviceAccount.private_key);
    console.log("[ga-auth] private_key length:", serviceAccount.private_key?.length || 0);
    console.log("[ga-auth] project_id:", serviceAccount.project_id || "(missing)");
  } catch (err) {
    console.error("[ga-auth] failed to parse GA_SERVICE_ACCOUNT_JSON:", err.message);
    console.error("[ga-auth] first 100 chars:", GA_SERVICE_ACCOUNT_JSON.substring(0, 100));
    return null;
  }

  console.log("[ga-auth] creating GoogleAuth with credentials...");
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  });
  console.log("[ga-auth] GoogleAuth created successfully");

  const analyticsData = google.analyticsdata({ version: "v1beta", auth });

  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const formatDate = (d) => d.toISOString().split("T")[0];

  console.log("[ga] fetching data for property:", GA_PROPERTY_ID);
  console.log("[ga] date range:", formatDate(thirtyDaysAgo), "to", formatDate(today));

  const res = await analyticsData.properties.runReport({
    property: `properties/${GA_PROPERTY_ID}`,
    requestBody: {
      dateRanges: [{ startDate: formatDate(thirtyDaysAgo), endDate: formatDate(today) }],
      metrics: [
        { name: "sessions" },
        { name: "screenPageViews" },
        { name: "activeUsers" },
        { name: "bounceRate" },
      ],
    },
  });

  const row = res.data.rows?.[0];
  if (!row) {
    console.log("[ga] no data returned");
    return { sessions: 0, pageViews: 0, users: 0, bounceRate: 0 };
  }

  const metrics = {
    sessions: parseInt(row.metricValues[0].value, 10),
    pageViews: parseInt(row.metricValues[1].value, 10),
    users: parseInt(row.metricValues[2].value, 10),
    bounceRate: parseFloat(row.metricValues[3].value),
  };

  console.log("[ga] data:", metrics);
  return metrics;
}

async function fetchMetaAdsData() {
  if (!META_SYSTEM_USER_TOKEN || !META_AD_ACCOUNT_ID) {
    console.log("[meta-api] skipping — META_SYSTEM_USER_TOKEN or META_AD_ACCOUNT_ID not set");
    return null;
  }

  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const since = thirtyDaysAgo.toISOString().split("T")[0];
  const until = today.toISOString().split("T")[0];

  const accountId = META_AD_ACCOUNT_ID.startsWith("act_")
    ? META_AD_ACCOUNT_ID
    : `act_${META_AD_ACCOUNT_ID}`;
  const timeRange = JSON.stringify({ since, until });
  const fields = "spend,impressions,clicks,actions,action_values";
  const url =
    `https://graph.facebook.com/v18.0/${accountId}/insights` +
    `?access_token=${encodeURIComponent(META_SYSTEM_USER_TOKEN)}` +
    `&time_range=${encodeURIComponent(timeRange)}` +
    `&fields=${fields}` +
    `&level=account`;

  console.log("[meta-api] fetching ad insights for account:", META_AD_ACCOUNT_ID);
  console.log("[meta-api] date range:", since, "to", until);

  const res = await fetch(url);
  const data = await res.json();

  console.log("[meta-api] response status:", res.status);

  if (data.error) {
    console.error("[meta-api] API error:", data.error.message);
    throw new Error(`Meta Ads API error: ${data.error.message}`);
  }

  const row = data.data?.[0];
  if (!row) {
    console.log("[meta-api] no ad data returned (no active campaigns?)");
    return { spend: 0, impressions: 0, clicks: 0, purchases: 0, revenue: 0 };
  }

  // Parse actions array to find purchase count
  const actions = row.actions || [];
  const purchaseAction = actions.find(a => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase");
  const purchases = purchaseAction ? parseInt(purchaseAction.value, 10) : 0;

  // Parse action_values to find purchase revenue
  const actionValues = row.action_values || [];
  const purchaseValue = actionValues.find(a => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase");
  const revenue = purchaseValue ? parseFloat(purchaseValue.value) : 0;

  const result = {
    spend: parseFloat(row.spend || 0),
    impressions: parseInt(row.impressions || 0, 10),
    clicks: parseInt(row.clicks || 0, 10),
    purchases,
    revenue,
  };

  console.log("[meta-api] data:", result);
  return result;
}

async function generateTileInsights(shopifyStats, gaData, metaAdsData, topProducts) {
  if (!ANTHROPIC_API_KEY) {
    console.log("[insights] ANTHROPIC_API_KEY not set");
    return null;
  }

  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  // Build shared data context
  let dataContext = `Store data from the last 30 days:\n`;
  dataContext += `Orders: ${shopifyStats.orderCount.toLocaleString()} (exact count)\n`;
  dataContext += `Average order value: \u00a3${shopifyStats.avgOrderValue.toFixed(2)} (based on ${shopifyStats.sampleSize} order sample)\n`;
  if (shopifyStats.revenueIsEstimated) {
    dataContext += `Estimated revenue: ~\u00a3${shopifyStats.revenue.toFixed(2)} (AOV \u00d7 order count)\n`;
  } else {
    dataContext += `Revenue: \u00a3${shopifyStats.revenue.toFixed(2)}\n`;
  }

  if (gaData) {
    dataContext += `Website sessions: ${gaData.sessions.toLocaleString()}\n`;
    dataContext += `Bounce rate: ${(gaData.bounceRate * 100).toFixed(1)}%\n`;
    dataContext += `Unique visitors: ${gaData.users.toLocaleString()}\n`;
    dataContext += `Page views: ${gaData.pageViews.toLocaleString()}\n`;
  } else {
    dataContext += `Website analytics: Not connected\n`;
  }

  if (metaAdsData) {
    dataContext += `\nMeta Ads (last 30 days):\n`;
    dataContext += `Ad spend: \u00a3${metaAdsData.spend.toFixed(2)}\n`;
    dataContext += `Impressions: ${metaAdsData.impressions.toLocaleString()}\n`;
    dataContext += `Clicks: ${metaAdsData.clicks.toLocaleString()}\n`;
    dataContext += `Purchases from ads: ${metaAdsData.purchases}\n`;
    dataContext += `Revenue from ads: \u00a3${metaAdsData.revenue.toFixed(2)}\n`;
    const roas = metaAdsData.spend > 0 ? (metaAdsData.revenue / metaAdsData.spend).toFixed(2) : "N/A";
    dataContext += `ROAS: ${roas}x\n`;
  } else {
    dataContext += `Meta Ads: Not connected\n`;
  }

  // Add top products context
  if (topProducts) {
    if (topProducts.byRevenue.length > 0) {
      dataContext += `\nTop products by revenue:\n`;
      topProducts.byRevenue.forEach((p, i) => {
        dataContext += `${i + 1}. ${p.title} \u2014 \u00a3${p.revenue.toFixed(2)} (${p.units} units)\n`;
      });
    }
    if (topProducts.byUnits.length > 0) {
      dataContext += `\nTop products by units sold:\n`;
      topProducts.byUnits.forEach((p, i) => {
        dataContext += `${i + 1}. ${p.title} \u2014 ${p.units} units (\u00a3${p.revenue.toFixed(2)})\n`;
      });
    }
  }

  const hasMetaAds = !!metaAdsData;

  const prompt = `You're a sharp e-commerce advisor. Concise, data-driven, actionable.

${dataContext}
STRICT RULES:
- Do NOT calculate conversion rate (orders \u00f7 sessions) \u2014 the data sources aren't linked
- Use \u00a3 for currency. If revenue is estimated, note with ~ prefix
- Use emoji STRATEGICALLY only: \ud83d\udcc8\ud83d\udcc9 trends, \ud83d\udcb0 money, \u26a0\ufe0f problems, \u2705 wins, \ud83c\udfaf actions
- No filler words. Every sentence must be actionable or data-driven
- NEVER just celebrate wins. Every positive MUST include "but here's how to go further"
- Format positives as: [Current state] \u2192 [Action] = [Expected result]
- Use SPECIFIC product names from the data. Never say "your products" \u2014 name them
${hasMetaAds ? "- ROAS = Revenue from ads \u00f7 Ad spend. Use this to assess ad efficiency\n" : ""}
Respond with EXACTLY these ${hasMetaAds ? "5" : "4"} sections using ### headers:

### HEALTH CHECK
Start with EXACTLY one status emoji: \ud83d\udfe2 (healthy), \ud83d\udfe1 (needs attention), or \ud83d\udd34 (critical).
One-line verdict. Then 3 key metrics on new lines: Revenue, Orders, AOV \u2014 each with brief context.
Every metric must include an improvement action. 40 words max total.

### BIGGEST ISSUE
The #1 thing costing money right now. Name the specific problem, the \u00a3 impact, and one fix. Be blunt. 30 words max.

### QUICK WIN
One specific action for THIS WEEK. Name the product/page/campaign. What to do and expected \u00a3 impact. 30 words max.

### OPPORTUNITY
One growth pattern from the data. Name specific products. Recommendation with realistic \u00a3 potential over 30 days. 30 words max.${hasMetaAds ? `

### AD PERFORMANCE
Start with EXACTLY one status emoji: \ud83d\udfe2 (ROAS >2.5), \ud83d\udfe1 (ROAS 1.5-2.5), or \ud83d\udd34 (ROAS <1.5).
ROAS value, verdict, and one specific optimization. Name what to change. 30 words max.` : ""}`;

  console.log("[insights] sending tile prompt to Claude...");

  const message = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: hasMetaAds ? 800 : 600,
    messages: [{ role: "user", content: prompt }],
  });

  const text = message.content[0]?.text || "";
  console.log("[insights] received tile response, length:", text.length);

  // Parse into tiles by splitting on ### headers
  const tiles = { healthCheck: "", biggestIssue: "", quickWin: "", opportunity: "", adPerformance: "" };
  const sections = text.split(/###\s*/);
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    const firstLine = trimmed.split("\n")[0].toUpperCase();
    const body = trimmed.replace(/^[^\n]+\n/, "").trim();
    if (firstLine.includes("HEALTH")) tiles.healthCheck = body;
    else if (firstLine.includes("ISSUE")) tiles.biggestIssue = body;
    else if (firstLine.includes("QUICK") || firstLine.includes("WIN")) tiles.quickWin = body;
    else if (firstLine.includes("OPPORTUN")) tiles.opportunity = body;
    else if (firstLine.includes("AD") && firstLine.includes("PERF")) tiles.adPerformance = body;
  }

  // Determine health check severity from emoji
  let healthSeverity = "healthy";
  if (tiles.healthCheck.includes("\ud83d\udfe1")) healthSeverity = "warning";
  else if (tiles.healthCheck.includes("\ud83d\udd34")) healthSeverity = "critical";

  // Determine ad performance severity from ROAS
  let adSeverity = "healthy";
  if (metaAdsData && metaAdsData.spend > 0) {
    const roas = metaAdsData.revenue / metaAdsData.spend;
    if (roas < 1.5) adSeverity = "critical";
    else if (roas <= 2.5) adSeverity = "warning";
  }

  tiles.healthSeverity = healthSeverity;
  tiles.adSeverity = adSeverity;

  console.log("[insights] parsed tiles:", Object.keys(tiles).map(k => `${k}: ${typeof tiles[k] === "string" ? tiles[k].length + " chars" : tiles[k]}`));
  return tiles;
}

// --- Routes ---

// Home — handle Shopify admin launch or manual install
app.get("/", (req, res) => {
  const shop = req.query.shop;

  // If shop param provided and token exists, go straight to dashboard
  if (shop && getShopToken(shop)) {
    return res.redirect(`/dashboard?shop=${encodeURIComponent(shop)}`);
  }

  // Shopify admin loads /?shop=store.myshopify.com in an iframe
  // Can't redirect — show a click-through that opens /install in top window
  if (shop && shop.match(/^[a-zA-Z0-9-]+\.myshopify\.com$/)) {
    const installUrl = `${HOST}/install?shop=${encodeURIComponent(shop)}`;
    return res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Authorize — Shopify Dashboard App</title>
        <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
        <script>
          shopify.config = {
            apiKey: ${JSON.stringify(SHOPIFY_API_KEY)},
            host: new URLSearchParams(window.location.search).get("host")
              || btoa(${JSON.stringify(shop + "/admin")}),
          };
        </script>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f6f6f7; }
          .card { background: #fff; border-radius: 12px; padding: 48px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: center; max-width: 440px; }
          h1 { margin: 0 0 8px; font-size: 22px; color: #1a1a1a; }
          p { color: #6b7177; margin: 0 0 24px; font-size: 15px; line-height: 1.5; }
          a.btn { display: inline-block; padding: 12px 28px; background: #008060; color: #fff; text-decoration: none; border-radius: 8px; font-size: 15px; font-weight: 500; }
          a.btn:hover { background: #006e52; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Please authorize this app</h1>
          <p>Click below to connect your store. A new window will open to complete authorization.</p>
          <a class="btn" href="${escapeHtml(installUrl)}" target="_top">Authorize App</a>
        </div>
      </body>
      </html>
    `);
  }

  // No shop param and no session — redirect to install page
  res.redirect("/install");
});

// OAuth landing page — runs in a normal browser tab, not embedded
app.get("/install", (req, res) => {
  const shop = req.query.shop || "";

  // If already authenticated, skip straight to dashboard
  if (shop && getShopToken(shop)) {
    return res.redirect(`/dashboard?shop=${encodeURIComponent(shop)}`);
  }
  const error = req.query.error || "";

  // Prevent this page from loading inside an iframe
  res.setHeader("X-Frame-Options", "DENY");

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Install — Shopify Dashboard App</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f6f6f7; }
        .card { background: #fff; border-radius: 12px; padding: 48px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: center; max-width: 440px; width: 100%; }
        h1 { margin: 0 0 8px; font-size: 24px; color: #1a1a1a; }
        p { color: #6b7177; margin: 0 0 24px; font-size: 15px; line-height: 1.5; }
        .error { background: #fef2f2; color: #b91c1c; padding: 10px 14px; border-radius: 8px; margin-bottom: 20px; font-size: 14px; }
        form { display: flex; flex-direction: column; gap: 12px; }
        input { padding: 12px 14px; border: 1px solid #c9cccf; border-radius: 8px; font-size: 14px; }
        button { padding: 12px 20px; background: #008060; color: #fff; border: none; border-radius: 8px; font-size: 15px; font-weight: 500; cursor: pointer; }
        button:hover { background: #006e52; }
        .hint { color: #999; font-size: 13px; margin-top: 8px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Shopify Dashboard</h1>
        <p>Connect your Shopify store to get started.</p>
        ${error === "token_expired" ? '<div class="error">Your session expired. Please reconnect.</div>' : ""}
        <form action="/auth" method="GET">
          <input type="text" name="shop" placeholder="your-store.myshopify.com" value="${escapeHtml(shop)}" required />
          <button type="submit">Authorize App</button>
        </form>
        <p class="hint">You'll be redirected to Shopify to approve access.</p>
      </div>
    </body>
    </html>
  `);
});

// Step 1: Redirect to Shopify OAuth consent screen
app.get("/auth", (req, res) => {
  const shop = req.query.shop;
  if (!shop || !shop.match(/^[a-zA-Z0-9-]+\.myshopify\.com$/)) {
    return res.status(400).send("Invalid shop parameter. Use: your-store.myshopify.com");
  }

  const nonce = generateNonce();
  req.session.nonce = nonce;
  req.session.pendingShop = shop;

  const redirectUri = buildRedirectUri();
  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_API_KEY}` +
    `&scope=${SCOPES}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${nonce}`;

  // X-Frame-Options: DENY forces the browser to break out of the iframe
  // when it receives the 302 redirect to Shopify's OAuth page
  res.setHeader("X-Frame-Options", "DENY");
  res.redirect(installUrl);
});

// Step 2: Handle OAuth callback
app.get("/auth/callback", async (req, res) => {
  const { shop, code, state, hmac } = req.query;

  console.log("[callback] shop:", shop);
  console.log("[callback] state from query:", state);
  console.log("[callback] nonce from session:", req.session.nonce);
  console.log("[callback] session ID:", req.sessionID);
  console.log("[callback] hmac present:", !!hmac);

  // Verify state/nonce
  if (state !== req.session.nonce) {
    console.log("[callback] STATE MISMATCH — query state:", JSON.stringify(state), "session nonce:", JSON.stringify(req.session.nonce));
    return res.status(403).send("State mismatch — possible CSRF attack.");
  }

  // Verify HMAC
  if (!hmac || !verifyHmac(req.query)) {
    console.log("[callback] HMAC FAILED");
    return res.status(403).send("HMAC validation failed.");
  }

  console.log("[callback] validation passed, exchanging token...");

  try {
    // Exchange code for permanent access token
    // Shopify's OAuth token endpoint expects form-encoded data, not JSON
    const tokenBody = new URLSearchParams({
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code,
    });

    console.log("[token] POST https://%s/admin/oauth/access_token", shop);

    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });

    const tokenText = await tokenRes.text();
    console.log("[token] status:", tokenRes.status);
    console.log("[token] response:", tokenText.substring(0, 200));

    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed (${tokenRes.status}): ${tokenText.substring(0, 200)}`);
    }

    const { access_token } = JSON.parse(tokenText);

    // Save token to in-memory store (works across standalone + embedded)
    setShopToken(shop, access_token);

    // Redirect into Shopify admin so the app loads embedded
    const storeSlug = shop.replace(".myshopify.com", "");
    const adminUrl = `https://admin.shopify.com/store/${storeSlug}/apps/${APP_HANDLE}`;
    console.log("[callback] redirecting to:", adminUrl);
    res.redirect(adminUrl);
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("Authentication failed. Check server logs.");
  }
});

// Dashboard — 4-tile insights view
app.get("/dashboard", async (req, res) => {
  const shop = req.query.shop;
  const tokenData = shop ? getShopToken(shop) : null;

  if (!shop || !tokenData) {
    if (shop) {
      return res.redirect(`/install?shop=${encodeURIComponent(shop)}`);
    }
    return res.redirect("/install");
  }

  const { accessToken } = tokenData;

  try {
    console.log("[dashboard] fetching data for shop:", shop);
    const shopData = await shopifyFetch(shop, accessToken, "shop");
    const storeName = shopData.shop.name;

    // Generate AI insights server-side (with 24hr cache)
    let insightsData = null;
    const forceRefresh = req.query.refresh === "1";

    if (ANTHROPIC_API_KEY) {
      // Check cache first
      if (!forceRefresh) {
        insightsData = getCachedInsights(shop);
        if (insightsData) {
          console.log("[dashboard] using cached insights from", new Date(insightsData.generatedAt).toISOString());
        }
      }

      // Generate fresh if no cache or forced refresh
      if (!insightsData) {
        try {
          console.log("[dashboard] generating fresh insights...");

          const thirtyDaysAgo = new Date();
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
          const sinceDate = thirtyDaysAgo.toISOString();

          // Get EXACT order count via count endpoint + sample for AOV
          const [countData, sampleData] = await Promise.all([
            shopifyFetch(
              shop,
              accessToken,
              `orders/count?status=any&created_at_min=${encodeURIComponent(sinceDate)}`
            ),
            shopifyFetch(
              shop,
              accessToken,
              `orders?status=any&financial_status=paid&created_at_min=${encodeURIComponent(sinceDate)}&limit=250`
            ),
          ]);

          const orderCount = countData.count || 0;
          const sampleOrders = sampleData.orders || [];
          const sampleSize = sampleOrders.length;
          const sampleRevenue = sampleOrders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
          const avgOrderValue = sampleSize > 0 ? sampleRevenue / sampleSize : 0;
          const revenueIsEstimated = sampleSize < orderCount;
          const revenue = revenueIsEstimated ? avgOrderValue * orderCount : sampleRevenue;

          console.log("[dashboard] order count (exact):", orderCount, "| sample:", sampleSize, "| AOV:", avgOrderValue.toFixed(2), "| revenue estimated:", revenueIsEstimated);

          const shopifyStats = { orderCount, revenue, avgOrderValue, sampleSize, revenueIsEstimated };

          // Extract top products from sample orders
          const productMap = {};
          for (const order of sampleOrders) {
            for (const item of (order.line_items || [])) {
              const key = item.title || "Unknown";
              if (!productMap[key]) productMap[key] = { title: key, revenue: 0, units: 0 };
              productMap[key].revenue += parseFloat(item.price || 0) * (item.quantity || 1);
              productMap[key].units += item.quantity || 1;
            }
          }
          const allProducts = Object.values(productMap);
          const topProducts = {
            byRevenue: [...allProducts].sort((a, b) => b.revenue - a.revenue).slice(0, 3),
            byUnits: [...allProducts].sort((a, b) => b.units - a.units).slice(0, 3),
          };
          console.log("[dashboard] top products by revenue:", topProducts.byRevenue.map(p => p.title));

          let gaData = null;
          try {
            gaData = await fetchGoogleAnalyticsData();
          } catch (gaErr) {
            console.log("[dashboard] GA fetch failed (continuing without):", gaErr.message);
          }

          let metaAdsData = null;
          try {
            metaAdsData = await fetchMetaAdsData();
          } catch (metaErr) {
            console.log("[dashboard] Meta Ads fetch failed (continuing without):", metaErr.message);
          }

          const tiles = await generateTileInsights(shopifyStats, gaData, metaAdsData, topProducts);

          insightsData = { tiles, shopifyStats, gaData, metaAdsData };
          setCachedInsights(shop, insightsData);
          insightsData = getCachedInsights(shop);
        } catch (insightsErr) {
          console.error("[dashboard] insights generation failed:", insightsErr.message);
          insightsData = null;
        }
      }
    }

    res.send(buildDashboardHtml(storeName, shop, insightsData));
  } catch (err) {
    console.error("Dashboard error:", err);
    if (err.message.includes("401")) {
      deleteShopToken(shop);
      return res.redirect(`/install?shop=${encodeURIComponent(shop)}&error=token_expired`);
    }
    res.status(500).send("Failed to load dashboard. Check server logs.");
  }
});

// Disconnect
app.get("/disconnect", (req, res) => {
  const shop = req.query.shop;
  if (shop) {
    deleteShopToken(shop);
  }
  req.session.destroy(() => {
    res.redirect("/install");
  });
});

// AI Insights — fetch Shopify + GA data and generate Claude analysis
app.get("/insights", async (req, res) => {
  const shop = req.query.shop;
  const tokenData = shop ? getShopToken(shop) : null;

  if (!shop || !tokenData) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  try {
    const { accessToken } = tokenData;

    // Fetch last 30 days — exact count + sample for AOV
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const sinceDate = thirtyDaysAgo.toISOString();

    console.log("[insights] fetching Shopify order stats since:", sinceDate);
    const [countData, sampleData] = await Promise.all([
      shopifyFetch(
        shop,
        accessToken,
        `orders/count?status=any&created_at_min=${encodeURIComponent(sinceDate)}`
      ),
      shopifyFetch(
        shop,
        accessToken,
        `orders?status=any&financial_status=paid&created_at_min=${encodeURIComponent(sinceDate)}&limit=250`
      ),
    ]);

    const orderCount = countData.count || 0;
    const sampleOrders = sampleData.orders || [];
    const sampleSize = sampleOrders.length;
    const sampleRevenue = sampleOrders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
    const avgOrderValue = sampleSize > 0 ? sampleRevenue / sampleSize : 0;
    const revenueIsEstimated = sampleSize < orderCount;
    const revenue = revenueIsEstimated ? avgOrderValue * orderCount : sampleRevenue;

    const shopifyStats = { orderCount, revenue, avgOrderValue, sampleSize, revenueIsEstimated };
    console.log("[insights] shopify stats:", shopifyStats);

    // Extract top products from sample orders
    const productMap = {};
    for (const order of sampleOrders) {
      for (const item of (order.line_items || [])) {
        const key = item.title || "Unknown";
        if (!productMap[key]) productMap[key] = { title: key, revenue: 0, units: 0 };
        productMap[key].revenue += parseFloat(item.price || 0) * (item.quantity || 1);
        productMap[key].units += item.quantity || 1;
      }
    }
    const allProducts = Object.values(productMap);
    const topProducts = {
      byRevenue: [...allProducts].sort((a, b) => b.revenue - a.revenue).slice(0, 3),
      byUnits: [...allProducts].sort((a, b) => b.units - a.units).slice(0, 3),
    };

    // Fetch GA data (may be null if not configured)
    let gaData = null;
    try {
      gaData = await fetchGoogleAnalyticsData();
    } catch (gaErr) {
      console.log("[insights] GA fetch failed (continuing without):", gaErr.message);
    }

    // Fetch Meta Ads data (may be null if not configured)
    let metaAdsData = null;
    try {
      metaAdsData = await fetchMetaAdsData();
    } catch (metaErr) {
      console.log("[insights] Meta Ads fetch failed (continuing without):", metaErr.message);
    }

    // Generate tile insights with Claude
    const tiles = await generateTileInsights(shopifyStats, gaData, metaAdsData, topProducts);

    res.json({
      shopifyStats,
      gaData,
      metaAdsData,
      tiles,
    });
  } catch (err) {
    console.error("[insights] error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Test Google Analytics — verify service account connection
app.get("/test-ga", async (_req, res) => {
  try {
    const data = await fetchGoogleAnalyticsData();
    if (!data) {
      return res.status(500).send(
        "Google Analytics not configured. Set GA_PROPERTY_ID and GA_SERVICE_ACCOUNT_JSON in .env"
      );
    }
    res.json({
      status: "ok",
      propertyId: GA_PROPERTY_ID,
      period: "last 30 days",
      metrics: data,
    });
  } catch (err) {
    console.error("[test-ga] error:", err);
    res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

// Settings — data source connection status
app.get("/settings", (req, res) => {
  const shop = req.query.shop;
  const tokenData = shop ? getShopToken(shop) : null;

  if (!shop || !tokenData) {
    if (shop) {
      return res.redirect(`/install?shop=${encodeURIComponent(shop)}`);
    }
    return res.redirect("/install");
  }

  res.send(buildSettingsHtml(shop));
});

// Health check for Railway
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// --- Dashboard HTML builder ---

function formatTileHtml(text) {
  if (!text) return "";
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function buildDashboardHtml(storeName, shop, insightsData) {
  const shopParam = encodeURIComponent(shop);
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const dateFrom = thirtyDaysAgo.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
  const dateTo = now.toLocaleDateString("en-GB", { month: "short", day: "numeric", year: "numeric" });
  const dateRange = `${dateFrom} - ${dateTo}`;

  const forceRefresh = false; // will be checked from query param in route
  const justRefreshed = insightsData && insightsData.generatedAt && (Date.now() - insightsData.generatedAt < 5000);

  // Data freshness cards
  let freshnessHtml = "";
  if (insightsData) {
    const stats = insightsData.shopifyStats;
    const ga = insightsData.gaData;
    const meta = insightsData.metaAdsData;
    const updatedAt = new Date(insightsData.generatedAt);
    const timeStr = updatedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const isToday = updatedAt.toDateString() === now.toDateString();
    const updatedLabel = isToday ? `Today at ${timeStr}` : updatedAt.toLocaleDateString("en-GB", { month: "short", day: "numeric" }) + ` at ${timeStr}`;

    const metaRoas = meta && meta.spend > 0 ? (meta.revenue / meta.spend).toFixed(2) : null;

    freshnessHtml = `
      ${justRefreshed ? '<div class="refresh-flash">\u2705 Insights refreshed</div>' : ""}
      <div class="freshness-cards">
        <div class="freshness-card">
          <div class="freshness-card-icon">\ud83d\uded2</div>
          <div class="freshness-card-body">
            <div class="freshness-card-title">Shopify</div>
            <div class="freshness-card-metric">${stats.orderCount.toLocaleString()} orders</div>
            <div class="freshness-card-sub">${dateRange}</div>
          </div>
        </div>
        <div class="freshness-card${ga ? "" : " freshness-card-off"}">
          <div class="freshness-card-icon">\ud83d\udcca</div>
          <div class="freshness-card-body">
            <div class="freshness-card-title">Analytics</div>
            ${ga
              ? `<div class="freshness-card-metric">${ga.sessions.toLocaleString()} sessions</div>
                 <div class="freshness-card-sub">${(ga.bounceRate * 100).toFixed(1)}% bounce</div>`
              : `<div class="freshness-card-metric dim">Not connected</div>`
            }
          </div>
        </div>
        <div class="freshness-card${meta ? "" : " freshness-card-off"}">
          <div class="freshness-card-icon">\ud83d\udcf1</div>
          <div class="freshness-card-body">
            <div class="freshness-card-title">Meta Ads</div>
            ${meta
              ? `<div class="freshness-card-metric">\u00a3${meta.spend.toFixed(0)} spend</div>
                 <div class="freshness-card-sub">${metaRoas}x ROAS</div>`
              : `<div class="freshness-card-metric dim">Not connected</div>`
            }
          </div>
        </div>
      </div>
      <div class="freshness-footer">
        Last updated: ${escapeHtml(updatedLabel)} &middot; <a href="/dashboard?shop=${shopParam}&refresh=1" class="refresh-link">\u2728 Refresh</a>
      </div>`;
  }

  // Get tiles and determine dynamic classes
  const tiles = insightsData?.tiles;
  const hasTiles = tiles && (tiles.healthCheck || tiles.biggestIssue || tiles.quickWin || tiles.opportunity || tiles.adPerformance);

  // Dynamic tile class based on severity
  const healthClass = tiles ? ({
    healthy: "tile-healthy",
    warning: "tile-warning",
    critical: "tile-critical",
  }[tiles.healthSeverity] || "tile-healthy") : "tile-healthy";

  const adClass = tiles ? ({
    healthy: "tile-healthy",
    warning: "tile-warning",
    critical: "tile-critical",
  }[tiles.adSeverity] || "tile-healthy") : "tile-healthy";

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Dashboard \u2014 ${escapeHtml(storeName)}</title>
      <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
      <script>
        shopify.config = {
          apiKey: ${JSON.stringify(SHOPIFY_API_KEY)},
          host: new URLSearchParams(window.location.search).get("host")
            || btoa(${JSON.stringify(shop + "/admin")}),
        };
      </script>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f6f6f7; color: #1a1a1a; }
        .topbar { background: #1a1a1a; color: #fff; padding: 16px 32px; display: flex; justify-content: space-between; align-items: center; }
        .topbar h1 { font-size: 18px; font-weight: 600; }
        .topbar nav { display: flex; gap: 20px; }
        .topbar a { color: #b5b5b5; text-decoration: none; font-size: 14px; }
        .topbar a:hover { color: #fff; }
        .topbar a.active { color: #fff; }
        .connected-bar { background: #008060; color: #fff; padding: 14px 32px; font-size: 15px; }
        .connected-bar strong { font-weight: 600; }
        .container { max-width: 960px; margin: 24px auto; padding: 0 24px; }

        /* Refresh flash */
        .refresh-flash { background: #dcfce7; color: #166534; padding: 12px 20px; border-radius: 10px; font-size: 14px; font-weight: 500; margin-bottom: 12px; text-align: center; animation: fadeOut 3s ease-in-out forwards; }
        @keyframes fadeOut { 0%, 70% { opacity: 1; } 100% { opacity: 0; } }

        /* Freshness cards */
        .freshness-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 8px; }
        .freshness-card { background: #fff; border-radius: 12px; padding: 16px; display: flex; gap: 12px; align-items: center; box-shadow: 0 1px 3px rgba(0,0,0,0.06); border: 1px solid #e5e7eb; }
        .freshness-card-off { opacity: 0.5; }
        .freshness-card-icon { font-size: 24px; }
        .freshness-card-body { flex: 1; }
        .freshness-card-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin-bottom: 2px; }
        .freshness-card-metric { font-size: 16px; font-weight: 700; color: #1a1a1a; }
        .freshness-card-metric.dim { font-weight: 400; color: #9ca3af; font-size: 13px; }
        .freshness-card-sub { font-size: 12px; color: #6b7280; margin-top: 1px; }
        .freshness-footer { font-size: 12px; color: #6b7280; text-align: center; padding: 8px 0 4px; margin-bottom: 16px; }
        .refresh-link { color: #008060; text-decoration: none; font-weight: 500; }
        .refresh-link:hover { text-decoration: underline; }

        /* Tile grid */
        .tile-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .tile { border-radius: 14px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
        .tile.full { grid-column: 1 / -1; }
        .tile-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 10px; }
        .tile-body { font-size: 15px; line-height: 1.7; color: #374151; }
        .tile-body strong { color: #1a1a1a; font-weight: 600; }

        /* Dynamic tile colors */
        .tile-healthy { background: linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%); border: 1px solid #bbf7d0; }
        .tile-healthy .tile-label { color: #166534; }
        .tile-warning { background: linear-gradient(135deg, #fefce8 0%, #fef9c3 100%); border: 1px solid #fde68a; }
        .tile-warning .tile-label { color: #92400e; }
        .tile-critical { background: linear-gradient(135deg, #fef2f2 0%, #fff1f2 100%); border: 1px solid #fecaca; }
        .tile-critical .tile-label { color: #991b1b; }
        .tile-action { background: linear-gradient(135deg, #eff6ff 0%, #f0f9ff 100%); border: 1px solid #bfdbfe; }
        .tile-action .tile-label { color: #1e40af; }
        .tile-opportunity { background: linear-gradient(135deg, #fefce8 0%, #fef9c3 100%); border: 1px solid #fde68a; }
        .tile-opportunity .tile-label { color: #92400e; }

        /* Error state */
        .insights-error { background: #fff; border-radius: 14px; padding: 40px; text-align: center; color: #6b7280; font-size: 15px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
        .insights-error a { color: #008060; text-decoration: none; font-weight: 500; }

        /* No API key state */
        .setup-card { background: #fff; border-radius: 14px; padding: 48px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
        .setup-card h2 { font-size: 18px; margin-bottom: 8px; }
        .setup-card p { color: #6b7280; font-size: 14px; line-height: 1.6; }

        @media (max-width: 640px) {
          .tile-grid { grid-template-columns: 1fr; }
          .tile.full { grid-column: 1; }
          .freshness-cards { grid-template-columns: 1fr; }
        }
      </style>
    </head>
    <body>
      <div class="topbar">
        <h1>Shopify Dashboard</h1>
        <nav>
          <a href="/dashboard?shop=${shopParam}" class="active">Dashboard</a>
          <a href="/settings?shop=${shopParam}">Settings</a>
        </nav>
      </div>
      <div class="connected-bar">Connected to: <strong>${escapeHtml(storeName)}</strong> (${escapeHtml(shop)})</div>
      <div class="container">

        ${freshnessHtml}

        ${!ANTHROPIC_API_KEY ? `
        <div class="setup-card">
          <h2>Add your Anthropic API key to get started</h2>
          <p>Set ANTHROPIC_API_KEY in your environment variables to enable AI-powered store insights.</p>
        </div>
        ` : !hasTiles ? `
        <div class="insights-error">
          Unable to generate insights. <a href="/dashboard?shop=${shopParam}&refresh=1">Try again</a>
        </div>
        ` : `
        <div class="tile-grid">

          <div class="tile ${healthClass} full">
            <div class="tile-label">\ud83c\udfe5 Health Check</div>
            <div class="tile-body">${formatTileHtml(tiles.healthCheck)}</div>
          </div>

          <div class="tile tile-critical">
            <div class="tile-label">\ud83d\udea8 Biggest Issue</div>
            <div class="tile-body">${formatTileHtml(tiles.biggestIssue)}</div>
          </div>

          <div class="tile tile-action">
            <div class="tile-label">\u26a1 Quick Win</div>
            <div class="tile-body">${formatTileHtml(tiles.quickWin)}</div>
          </div>

          <div class="tile tile-opportunity full">
            <div class="tile-label">\ud83c\udf1f Opportunity</div>
            <div class="tile-body">${formatTileHtml(tiles.opportunity)}</div>
          </div>

          ${tiles.adPerformance ? `
          <div class="tile ${adClass} full">
            <div class="tile-label">\ud83d\udcb0 Ad Performance</div>
            <div class="tile-body">${formatTileHtml(tiles.adPerformance)}</div>
          </div>
          ` : ""}

        </div>
        `}

      </div>
    </body>
    </html>
  `;
}

function buildSettingsHtml(shop) {
  const shopParam = encodeURIComponent(shop);
  const metaConfigured = !!(META_SYSTEM_USER_TOKEN && META_AD_ACCOUNT_ID);
  const gaConfigured = !!(GA_PROPERTY_ID && GA_SERVICE_ACCOUNT_JSON);
  const claudeConfigured = !!ANTHROPIC_API_KEY;

  const accountIdDisplay = META_AD_ACCOUNT_ID
    ? (META_AD_ACCOUNT_ID.length > 10 ? META_AD_ACCOUNT_ID.substring(0, 10) + "\u2026" : META_AD_ACCOUNT_ID)
    : "";

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Settings \u2014 Data Sources</title>
      <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
      <script>
        shopify.config = {
          apiKey: ${JSON.stringify(SHOPIFY_API_KEY)},
          host: new URLSearchParams(window.location.search).get("host")
            || btoa(${JSON.stringify(shop + "/admin")}),
        };
      </script>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f6f6f7; color: #1a1a1a; }
        .topbar { background: #1a1a1a; color: #fff; padding: 16px 32px; display: flex; justify-content: space-between; align-items: center; }
        .topbar h1 { font-size: 18px; font-weight: 600; }
        .topbar nav { display: flex; gap: 20px; }
        .topbar a { color: #b5b5b5; text-decoration: none; font-size: 14px; }
        .topbar a:hover { color: #fff; }
        .topbar a.active { color: #fff; }
        .container { max-width: 720px; margin: 32px auto; padding: 0 24px; }
        .settings-title { font-size: 20px; font-weight: 600; margin-bottom: 20px; color: #1a1a1a; }
        .source-card { background: #fff; border-radius: 14px; padding: 20px 24px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); border: 1px solid #e5e7eb; display: flex; align-items: center; gap: 16px; }
        .source-card.connected { border-left: 4px solid #10b981; }
        .source-card.disconnected { border-left: 4px solid #d1d5db; opacity: 0.7; }
        .source-card-icon { font-size: 28px; width: 48px; height: 48px; border-radius: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .icon-shopify { background: #96bf48; color: #fff; font-size: 20px; font-weight: 700; }
        .icon-ga { background: #e37400; color: #fff; font-size: 20px; font-weight: 700; }
        .icon-meta { background: #1877f2; color: #fff; font-size: 20px; font-weight: 700; }
        .icon-claude { background: #d97706; color: #fff; font-size: 20px; font-weight: 700; }
        .source-card-body { flex: 1; }
        .source-card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
        .source-card-name { font-size: 16px; font-weight: 600; }
        .source-card-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
        .badge-connected { background: #dcfce7; color: #166534; }
        .badge-off { background: #f3f4f6; color: #6b7280; }
        .source-card-detail { font-size: 13px; color: #6b7280; line-height: 1.4; }
      </style>
    </head>
    <body>
      <div class="topbar">
        <h1>Shopify Dashboard</h1>
        <nav>
          <a href="/dashboard?shop=${shopParam}">Dashboard</a>
          <a href="/settings?shop=${shopParam}" class="active">Settings</a>
        </nav>
      </div>
      <div class="container">
        <div class="settings-title">Data Sources</div>

        <div class="source-card connected">
          <div class="source-card-icon icon-shopify">S</div>
          <div class="source-card-body">
            <div class="source-card-header">
              <span class="source-card-name">Shopify</span>
              <span class="source-card-badge badge-connected">\u2705 Connected</span>
            </div>
            <div class="source-card-detail">${escapeHtml(shop)}</div>
          </div>
        </div>

        <div class="source-card ${gaConfigured ? "connected" : "disconnected"}">
          <div class="source-card-icon icon-ga">G</div>
          <div class="source-card-body">
            <div class="source-card-header">
              <span class="source-card-name">Google Analytics</span>
              ${gaConfigured
                ? '<span class="source-card-badge badge-connected">\u2705 Connected</span>'
                : '<span class="source-card-badge badge-off">Not configured</span>'
              }
            </div>
            <div class="source-card-detail">${gaConfigured
              ? `Property ID: ${escapeHtml(GA_PROPERTY_ID)}<br>Service account active`
              : "Add GA_PROPERTY_ID and GA_SERVICE_ACCOUNT_JSON to env"
            }</div>
          </div>
        </div>

        <div class="source-card ${metaConfigured ? "connected" : "disconnected"}">
          <div class="source-card-icon icon-meta">f</div>
          <div class="source-card-body">
            <div class="source-card-header">
              <span class="source-card-name">Meta Ads</span>
              ${metaConfigured
                ? '<span class="source-card-badge badge-connected">\u2705 Connected</span>'
                : '<span class="source-card-badge badge-off">Not configured</span>'
              }
            </div>
            <div class="source-card-detail">${metaConfigured
              ? `System User connected<br>Account: ${escapeHtml(accountIdDisplay)}`
              : "Add META_SYSTEM_USER_TOKEN and META_AD_ACCOUNT_ID to env"
            }</div>
          </div>
        </div>

        <div class="source-card ${claudeConfigured ? "connected" : "disconnected"}">
          <div class="source-card-icon icon-claude">AI</div>
          <div class="source-card-body">
            <div class="source-card-header">
              <span class="source-card-name">Claude AI</span>
              ${claudeConfigured
                ? '<span class="source-card-badge badge-connected">\u2705 Connected</span>'
                : '<span class="source-card-badge badge-off">Not configured</span>'
              }
            </div>
            <div class="source-card-detail">${claudeConfigured
              ? "Generating business insights"
              : "Add ANTHROPIC_API_KEY to env"
            }</div>
          </div>
        </div>

      </div>
    </body>
    </html>
  `;
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Start ---

app.listen(PORT, () => {
  console.log(`Shopify Dashboard App running on port ${PORT}`);
  if (HOST) {
    console.log(`OAuth callback: ${HOST}/auth/callback`);
  } else {
    console.warn("WARNING: HOST env var not set — OAuth redirects will fail.");
  }
});
