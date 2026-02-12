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
  const existing = shopTokens[shop];
  shopTokens[shop] = {
    accessToken,
    installedAt: Date.now(),
    metaAdsToken: existing?.metaAdsToken || null,
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
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
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

async function generateInsights(shopifyStats, gaData) {
  if (!ANTHROPIC_API_KEY) {
    console.log("[insights] ANTHROPIC_API_KEY not set");
    return null;
  }

  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  let dataPrompt = `You're a trusted e-commerce advisor speaking directly to a store owner.\nData from the last 30 days:\n\n`;

  dataPrompt += `Orders: ${shopifyStats.orderCount.toLocaleString()} (exact count)\n`;
  dataPrompt += `Average order value: \u00a3${shopifyStats.avgOrderValue.toFixed(2)} (based on ${shopifyStats.sampleSize} order sample)\n`;
  if (shopifyStats.revenueIsEstimated) {
    dataPrompt += `Estimated revenue: ~\u00a3${shopifyStats.revenue.toFixed(2)} (AOV \u00d7 order count)\n`;
  } else {
    dataPrompt += `Revenue: \u00a3${shopifyStats.revenue.toFixed(2)}\n`;
  }

  if (gaData) {
    dataPrompt += `Website sessions: ${gaData.sessions.toLocaleString()}\n`;
    dataPrompt += `Bounce rate: ${(gaData.bounceRate * 100).toFixed(1)}%\n`;
    dataPrompt += `Unique visitors: ${gaData.users.toLocaleString()}\n`;
  } else {
    dataPrompt += `Website analytics: Not connected\n`;
  }

  dataPrompt += `\nIMPORTANT: Do NOT calculate conversion rate (orders \u00f7 sessions) — the data sources aren't linked and the result would be misleading. Focus on the metrics you have.\n`;
  dataPrompt += `If revenue is marked as estimated, mention that briefly.\n\n`;
  dataPrompt += `Respond in a conversational tone (like texting a knowledgeable friend, not writing a consultant report):\n`;
  dataPrompt += `**Status:** One line — is the business healthy, struggling, or thriving?\n`;
  dataPrompt += `**The Main Issue:** What's the biggest problem hurting performance right now? Be specific.\n`;
  dataPrompt += `**Why It Matters:** Show the financial impact in real \u00a3 numbers.\n`;
  dataPrompt += `**Quick Win:** One thing they can do THIS WEEK to improve. Be specific and actionable.\n`;
  dataPrompt += `**Bigger Opportunity:** One 30-day goal that could significantly move the needle.\n\n`;
  dataPrompt += `Keep it under 200 words total. Use "you" and "your". Be direct and helpful, not formal.\n`;
  dataPrompt += `Use the exact section headers above (Status, The Main Issue, Why It Matters, Quick Win, Bigger Opportunity) with ** markdown bold.`;

  console.log("[insights] sending data to Claude...");

  const message = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 512,
    messages: [{ role: "user", content: dataPrompt }],
  });

  const text = message.content[0]?.text || "";
  console.log("[insights] received response, length:", text.length);
  return text;
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

// Dashboard — show store info, products, orders
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
    const [shopData, productsData, ordersData] = await Promise.all([
      shopifyFetch(shop, accessToken, "shop"),
      shopifyFetch(shop, accessToken, "products?limit=5"),
      shopifyFetch(shop, accessToken, "orders?limit=5&status=any"),
    ]);
    console.log("[dashboard] all 3 API calls succeeded");

    const storeName = shopData.shop.name;
    const products = productsData.products || [];
    const orders = ordersData.orders || [];

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

          // Fetch last 30 days of orders for stats
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

          // Revenue: exact if we have all orders, estimated if sample < total
          const revenueIsEstimated = sampleSize < orderCount;
          const revenue = revenueIsEstimated ? avgOrderValue * orderCount : sampleRevenue;

          console.log("[dashboard] order count (exact):", orderCount, "| sample:", sampleSize, "| AOV:", avgOrderValue.toFixed(2), "| revenue estimated:", revenueIsEstimated);

          const shopifyStats = { orderCount, revenue, avgOrderValue, sampleSize, revenueIsEstimated };

          // Fetch GA data (may be null if not configured)
          let gaData = null;
          try {
            gaData = await fetchGoogleAnalyticsData();
          } catch (gaErr) {
            console.log("[dashboard] GA fetch failed (continuing without):", gaErr.message);
          }

          const insights = await generateInsights(shopifyStats, gaData);
          console.log("[dashboard] insights generated, length:", insights?.length || 0);

          insightsData = { insights, shopifyStats, gaData };
          setCachedInsights(shop, insightsData);
          // Re-read to get the generatedAt timestamp
          insightsData = getCachedInsights(shop);
        } catch (insightsErr) {
          console.error("[dashboard] insights generation failed:", insightsErr.message);
          insightsData = null;
        }
      }
    }

    res.send(buildDashboardHtml(storeName, shop, products, orders, insightsData));
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

    // Fetch GA data (may be null if not configured)
    let gaData = null;
    try {
      gaData = await fetchGoogleAnalyticsData();
    } catch (gaErr) {
      console.log("[insights] GA fetch failed (continuing without):", gaErr.message);
    }

    // Generate insights with Claude
    const insights = await generateInsights(shopifyStats, gaData);

    res.json({
      shopifyStats,
      gaData,
      insights,
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

  res.send(buildSettingsHtml(shop, tokenData));
});

// Health check for Railway
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// --- Dashboard HTML builder ---

function buildDashboardHtml(storeName, shop, products, orders, insightsData) {

  const productRows = products
    .map(
      (p) => `
      <tr>
        <td>${escapeHtml(p.title)}</td>
        <td>${p.status}</td>
        <td>${p.variants?.[0]?.price || "N/A"}</td>
        <td>${p.variants?.[0]?.inventory_quantity ?? "N/A"}</td>
      </tr>`
    )
    .join("");

  const orderRows = orders
    .map(
      (o) => `
      <tr>
        <td>${escapeHtml(o.name)}</td>
        <td>${new Date(o.created_at).toLocaleDateString()}</td>
        <td>${o.financial_status}</td>
        <td>${o.currency} ${o.total_price}</td>
      </tr>`
    )
    .join("");

  // Data freshness indicators
  const shopParam = encodeURIComponent(shop);
  const gaConfigured = !!(GA_PROPERTY_ID && GA_SERVICE_ACCOUNT_JSON);
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const dateFrom = thirtyDaysAgo.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
  const dateTo = now.toLocaleDateString("en-GB", { month: "short", day: "numeric", year: "numeric" });
  const dateRange = `${dateFrom} - ${dateTo}`;

  let freshnessHtml = "";
  if (insightsData) {
    const stats = insightsData.shopifyStats;
    const ga = insightsData.gaData;
    const updatedAt = new Date(insightsData.generatedAt);
    const timeStr = updatedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const isToday = updatedAt.toDateString() === now.toDateString();
    const updatedLabel = isToday ? `Today at ${timeStr}` : updatedAt.toLocaleDateString("en-GB", { month: "short", day: "numeric" }) + ` at ${timeStr}`;

    freshnessHtml = `
      <div class="freshness">
        <div class="freshness-sources">
          <span class="freshness-item connected-source">Shopify: ${stats.orderCount.toLocaleString()} orders (${dateRange})</span>
          ${ga
            ? `<span class="freshness-item connected-source">Google Analytics: ${ga.sessions.toLocaleString()} sessions (${dateRange})</span>`
            : `<span class="freshness-item disconnected-source">Google Analytics: Not connected</span>`
          }
          <span class="freshness-item disconnected-source">Meta Ads: Not connected</span>
        </div>
        <div class="freshness-meta">
          Last updated: ${escapeHtml(updatedLabel)}
        </div>
      </div>`;
  }

  // Format insights text — convert **bold** to <strong> and preserve line breaks
  let insightsHtml = "";
  if (insightsData && insightsData.insights) {
    insightsHtml = escapeHtml(insightsData.insights)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");
  }

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
        .connected { background: #008060; color: #fff; padding: 14px 32px; font-size: 15px; }
        .connected strong { font-weight: 600; }
        .container { max-width: 960px; margin: 32px auto; padding: 0 24px; }

        /* Insights hero section */
        .insights-section { background: linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 50%, #f0f9ff 100%); border: 1px solid #d1fae5; border-radius: 16px; padding: 32px; margin-bottom: 28px; }
        .insights-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
        .insights-title { font-size: 20px; font-weight: 600; color: #1a1a1a; }
        .insights-body { font-size: 15px; line-height: 1.8; color: #374151; }
        .insights-body strong { color: #1a1a1a; font-weight: 600; }
        .insights-body br + br { display: block; content: ""; margin-top: 4px; }
        .insights-error { color: #b91c1c; font-size: 15px; }
        .insights-footer { display: flex; align-items: center; justify-content: flex-end; margin-top: 20px; padding-top: 16px; border-top: 1px solid #d1fae5; }
        .btn-refresh { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; background: #fff; color: #374151; border: 1px solid #d1d5db; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; text-decoration: none; transition: all 0.15s; }
        .btn-refresh:hover { background: #f9fafb; border-color: #9ca3af; }

        /* Data freshness */
        .freshness { margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #d1fae5; }
        .freshness-sources { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 6px; }
        .freshness-item { font-size: 12px; padding: 4px 10px; border-radius: 6px; font-weight: 500; }
        .connected-source { background: #dcfce7; color: #166534; }
        .disconnected-source { background: #f3f4f6; color: #6b7280; }
        .freshness-meta { font-size: 12px; color: #6b7280; }

        /* Collapsible tables */
        .section { background: #fff; border-radius: 12px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
        .section summary { padding: 18px 24px; font-size: 15px; font-weight: 600; color: #333; cursor: pointer; list-style: none; display: flex; align-items: center; justify-content: space-between; }
        .section summary::-webkit-details-marker { display: none; }
        .section summary::after { content: "\\25B8"; color: #9ca3af; font-size: 14px; transition: transform 0.2s; }
        .section[open] summary::after { transform: rotate(90deg); }
        .section .section-body { padding: 0 24px 24px; }
        .section .count-badge { font-size: 12px; font-weight: 500; color: #6b7280; background: #f3f4f6; padding: 2px 8px; border-radius: 10px; margin-left: 8px; }
        table { width: 100%; border-collapse: collapse; font-size: 14px; }
        th { text-align: left; padding: 10px 12px; border-bottom: 2px solid #e1e3e5; color: #6b7177; font-weight: 500; font-size: 13px; }
        td { padding: 10px 12px; border-bottom: 1px solid #f1f1f1; }
        .empty { color: #999; font-style: italic; padding: 16px 0; }
      </style>
    </head>
    <body>
      <div class="topbar">
        <h1>Shopify Dashboard</h1>
        <nav>
          <a href="/dashboard?shop=${shopParam}" class="active">Dashboard</a>
          <a href="/settings?shop=${shopParam}">Settings</a>
          <a href="/disconnect?shop=${shopParam}">Disconnect</a>
        </nav>
      </div>
      <div class="connected">Connected to: <strong>${escapeHtml(storeName)}</strong> (${escapeHtml(shop)})</div>
      <div class="container">

        ${ANTHROPIC_API_KEY ? `
        <div class="insights-section">
          <div class="insights-header">
            <div class="insights-title">Your Store Insights</div>
          </div>
          ${freshnessHtml}
          <div id="insights">
            ${insightsHtml
              ? `<div class="insights-body">${insightsHtml}</div>`
              : '<p class="insights-error">Unable to generate insights. Check your API key and try refreshing.</p>'
            }
          </div>
          <div class="insights-footer">
            <a class="btn-refresh" href="/dashboard?shop=${shopParam}&refresh=1">Refresh insights</a>
          </div>
        </div>
        ` : ""}

        <details class="section" open>
          <summary>Recent Products <span class="count-badge">${products.length}</span></summary>
          <div class="section-body">
          ${
            products.length
              ? `<table>
                  <thead><tr><th>Title</th><th>Status</th><th>Price</th><th>Inventory</th></tr></thead>
                  <tbody>${productRows}</tbody>
                </table>`
              : '<p class="empty">No products found.</p>'
          }
          </div>
        </details>

        <details class="section">
          <summary>Recent Orders <span class="count-badge">${orders.length}</span></summary>
          <div class="section-body">
          ${
            orders.length
              ? `<table>
                  <thead><tr><th>Order</th><th>Date</th><th>Status</th><th>Total</th></tr></thead>
                  <tbody>${orderRows}</tbody>
                </table>`
              : '<p class="empty">No orders found.</p>'
          }
          </div>
        </details>

      </div>
    </body>
    </html>
  `;
}

function buildSettingsHtml(shop, tokenData) {
  const shopParam = encodeURIComponent(shop);
  const metaConnected = !!tokenData.metaAdsToken;
  const gaConfigured = !!(GA_PROPERTY_ID && GA_SERVICE_ACCOUNT_JSON);

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Settings — Data Sources</title>
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
        .container { max-width: 960px; margin: 32px auto; padding: 0 24px; }
        .section { background: #fff; border-radius: 12px; padding: 24px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
        .section h2 { font-size: 16px; margin-bottom: 16px; color: #333; }
        .source-row { display: flex; align-items: center; justify-content: space-between; padding: 16px 0; border-bottom: 1px solid #f1f1f1; }
        .source-row:last-child { border-bottom: none; }
        .source-info { display: flex; align-items: center; gap: 12px; }
        .source-icon { width: 40px; height: 40px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 18px; }
        .source-icon.shopify { background: #96bf48; color: #fff; }
        .source-icon.meta { background: #1877f2; color: #fff; }
        .source-icon.ga { background: #e37400; color: #fff; }
        .source-name { font-size: 15px; font-weight: 500; }
        .source-desc { font-size: 13px; color: #6b7177; margin-top: 2px; }
        .status-connected { color: #008060; font-size: 14px; font-weight: 500; }
        .btn-connect { display: inline-block; padding: 8px 20px; background: #008060; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; }
        .btn-connect:hover { background: #006e52; }
      </style>
    </head>
    <body>
      <div class="topbar">
        <h1>Shopify Dashboard</h1>
        <nav>
          <a href="/dashboard?shop=${shopParam}">Dashboard</a>
          <a href="/settings?shop=${shopParam}" class="active">Settings</a>
          <a href="/disconnect?shop=${shopParam}">Disconnect</a>
        </nav>
      </div>
      <div class="container">
        <div class="section">
          <h2>Data Sources</h2>

          <div class="source-row">
            <div class="source-info">
              <div class="source-icon shopify">S</div>
              <div>
                <div class="source-name">Shopify</div>
                <div class="source-desc">Orders, products, and store data</div>
              </div>
            </div>
            <span class="status-connected">&#10003; Connected</span>
          </div>

          <div class="source-row">
            <div class="source-info">
              <div class="source-icon meta">f</div>
              <div>
                <div class="source-name">Meta Ads</div>
                <div class="source-desc">Ad spend, impressions, and conversions</div>
              </div>
            </div>
            ${metaConnected
              ? '<span class="status-connected">&#10003; Connected</span>'
              : `<a class="btn-connect" href="/connect/meta?shop=${shopParam}">Connect</a>`
            }
          </div>

          <div class="source-row">
            <div class="source-info">
              <div class="source-icon ga">G</div>
              <div>
                <div class="source-name">Google Analytics</div>
                <div class="source-desc">Traffic, sessions, and user behavior</div>
              </div>
            </div>
            ${gaConfigured
              ? `<span class="status-connected">&#10003; Connected (${escapeHtml(GA_PROPERTY_ID)})</span>`
              : '<span style="color:#6b7177;font-size:13px">Not configured &mdash; add GA_PROPERTY_ID to env</span>'
            }
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
