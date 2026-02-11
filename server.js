require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const session = require("express-session");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SCOPES = "read_products,read_orders";
const HOST = process.env.HOST; // e.g. https://your-app.up.railway.app

if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
  console.error("Missing SHOPIFY_API_KEY or SHOPIFY_API_SECRET env vars");
  process.exit(1);
}

app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === "production" },
  })
);

app.use(express.json());

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
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hmac));
}

async function shopifyFetch(shop, accessToken, endpoint) {
  const url = `https://${shop}/admin/api/2024-01/${endpoint}.json`;
  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Shopify API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// --- Routes ---

// Home — start install flow
app.get("/", (req, res) => {
  if (req.session.shop && req.session.accessToken) {
    return res.redirect("/dashboard");
  }
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="utf-8"><title>Shopify Dashboard App</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f6f6f7; }
      .card { background: #fff; border-radius: 12px; padding: 48px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: center; max-width: 420px; }
      h1 { margin: 0 0 8px; font-size: 24px; }
      p { color: #6b7177; margin: 0 0 24px; }
      form { display: flex; gap: 8px; }
      input { flex: 1; padding: 10px 14px; border: 1px solid #c9cccf; border-radius: 8px; font-size: 14px; }
      button { padding: 10px 20px; background: #008060; color: #fff; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; }
      button:hover { background: #006e52; }
    </style>
    </head>
    <body>
      <div class="card">
        <h1>Shopify Dashboard</h1>
        <p>Enter your Shopify store domain to connect.</p>
        <form action="/auth" method="GET">
          <input type="text" name="shop" placeholder="your-store.myshopify.com" required />
          <button type="submit">Connect</button>
        </form>
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

  const redirectUri = buildRedirectUri();
  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_API_KEY}` +
    `&scope=${SCOPES}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${nonce}`;

  res.redirect(installUrl);
});

// Step 2: Handle OAuth callback
app.get("/auth/callback", async (req, res) => {
  const { shop, code, state, hmac } = req.query;

  // Verify state/nonce
  if (state !== req.session.nonce) {
    return res.status(403).send("State mismatch — possible CSRF attack.");
  }

  // Verify HMAC
  if (!hmac || !verifyHmac(req.query)) {
    return res.status(403).send("HMAC validation failed.");
  }

  try {
    // Exchange code for permanent access token
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
      }),
    });

    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${await tokenRes.text()}`);
    }

    const { access_token } = await tokenRes.json();

    req.session.shop = shop;
    req.session.accessToken = access_token;

    res.redirect("/dashboard");
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("Authentication failed. Check server logs.");
  }
});

// Dashboard — show store info, products, orders
app.get("/dashboard", async (req, res) => {
  const { shop, accessToken } = req.session;
  if (!shop || !accessToken) {
    return res.redirect("/");
  }

  try {
    const [shopData, productsData, ordersData] = await Promise.all([
      shopifyFetch(shop, accessToken, "shop"),
      shopifyFetch(shop, accessToken, "products?limit=5"),
      shopifyFetch(shop, accessToken, "orders?limit=5&status=any"),
    ]);

    const storeName = shopData.shop.name;
    const products = productsData.products || [];
    const orders = ordersData.orders || [];

    res.send(buildDashboardHtml(storeName, shop, products, orders));
  } catch (err) {
    console.error("Dashboard error:", err);
    if (err.message.includes("401")) {
      req.session.destroy(() => {});
      return res.redirect("/?error=token_expired");
    }
    res.status(500).send("Failed to load dashboard. Check server logs.");
  }
});

// Disconnect
app.get("/disconnect", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

// Health check for Railway
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// --- Dashboard HTML builder ---

function buildDashboardHtml(storeName, shop, products, orders) {
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

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Dashboard — ${escapeHtml(storeName)}</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f6f6f7; color: #1a1a1a; }
        .topbar { background: #1a1a1a; color: #fff; padding: 16px 32px; display: flex; justify-content: space-between; align-items: center; }
        .topbar h1 { font-size: 18px; font-weight: 600; }
        .topbar a { color: #b5b5b5; text-decoration: none; font-size: 14px; }
        .topbar a:hover { color: #fff; }
        .connected { background: #008060; color: #fff; padding: 14px 32px; font-size: 15px; }
        .connected strong { font-weight: 600; }
        .container { max-width: 960px; margin: 32px auto; padding: 0 24px; }
        .section { background: #fff; border-radius: 12px; padding: 24px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
        .section h2 { font-size: 16px; margin-bottom: 16px; color: #333; }
        table { width: 100%; border-collapse: collapse; font-size: 14px; }
        th { text-align: left; padding: 10px 12px; border-bottom: 2px solid #e1e3e5; color: #6b7177; font-weight: 500; font-size: 13px; }
        td { padding: 10px 12px; border-bottom: 1px solid #f1f1f1; }
        .empty { color: #999; font-style: italic; padding: 16px 0; }
      </style>
    </head>
    <body>
      <div class="topbar">
        <h1>Shopify Dashboard</h1>
        <a href="/disconnect">Disconnect</a>
      </div>
      <div class="connected">Connected to: <strong>${escapeHtml(storeName)}</strong> (${escapeHtml(shop)})</div>
      <div class="container">
        <div class="section">
          <h2>Recent Products</h2>
          ${
            products.length
              ? `<table>
                  <thead><tr><th>Title</th><th>Status</th><th>Price</th><th>Inventory</th></tr></thead>
                  <tbody>${productRows}</tbody>
                </table>`
              : '<p class="empty">No products found.</p>'
          }
        </div>
        <div class="section">
          <h2>Recent Orders</h2>
          ${
            orders.length
              ? `<table>
                  <thead><tr><th>Order</th><th>Date</th><th>Status</th><th>Total</th></tr></thead>
                  <tbody>${orderRows}</tbody>
                </table>`
              : '<p class="empty">No orders found.</p>'
          }
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
