const config = require("./lib/config");
const express = require("express");
const session = require("express-session");

const app = express();

app.use(express.json());
app.use(express.static("public"));

// Trust reverse proxy in production (Railway, etc.)
if (config.isProduction) {
  app.set("trust proxy", 1);
}

// Session middleware (used during OAuth flow)
app.use(
  session({
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: {
      secure: true,
      sameSite: "none",
      maxAge: 3600000,
    },
  })
);

// CORS — restrict to Shopify admin domains
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = [
    /^https:\/\/[a-zA-Z0-9-]+\.myshopify\.com$/,
    /^https:\/\/admin\.shopify\.com$/,
  ];
  if (origin && allowedOrigins.some(pattern => pattern.test(origin))) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// CSP — allow Shopify admin to frame this app (validated shop param only)
app.use((req, res, next) => {
  const shop = req.query.shop;
  if (shop && /^[a-zA-Z0-9-]+\.myshopify\.com$/.test(shop)) {
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

// Register routes
app.use(require("./routes/auth"));
app.use(require("./routes/dashboard"));
app.use(require("./routes/settings"));
app.use(require("./routes/api"));

// Start
app.listen(config.PORT, () => {
  console.log(`Shopify Dashboard App running on port ${config.PORT}`);
  if (config.HOST) {
    console.log(`OAuth callback: ${config.HOST}/auth/callback`);
  } else {
    console.warn("WARNING: HOST env var not set \u2014 OAuth redirects will fail.");
  }
});
