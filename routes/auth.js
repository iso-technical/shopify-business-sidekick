const express = require("express");
const router = express.Router();
const config = require("../lib/config");
const logger = require("../lib/logger");
const { getShopToken, setShopToken } = require("../lib/cache");
const { verifyHmac, buildRedirectUri, generateNonce } = require("../lib/shopify");
const { buildAuthorizePage, buildInstallPage } = require("../views/auth");

// Home — handle Shopify admin launch or manual install
router.get("/", (req, res) => {
  const shop = req.query.shop;

  if (shop && getShopToken(shop)) {
    return res.redirect(`/dashboard?shop=${encodeURIComponent(shop)}`);
  }

  if (shop && shop.match(/^[a-zA-Z0-9-]+\.myshopify\.com$/)) {
    return res.send(buildAuthorizePage(shop));
  }

  res.redirect("/install");
});

// OAuth landing page — runs in a normal browser tab, not embedded
router.get("/install", (req, res) => {
  const shop = req.query.shop || "";

  if (shop && getShopToken(shop)) {
    return res.redirect(`/dashboard?shop=${encodeURIComponent(shop)}`);
  }
  const error = req.query.error || "";

  res.setHeader("X-Frame-Options", "DENY");
  res.send(buildInstallPage(shop, error));
});

// Step 1: Redirect to Shopify OAuth consent screen
router.get("/auth", (req, res) => {
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
    `?client_id=${config.SHOPIFY_API_KEY}` +
    `&scope=${config.SCOPES}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${nonce}`;

  res.setHeader("X-Frame-Options", "DENY");
  res.redirect(installUrl);
});

// Step 2: Handle OAuth callback
router.get("/auth/callback", async (req, res) => {
  const { shop, code, state, hmac } = req.query;

  logger.info("[callback] shop:", shop);
  logger.debug("[callback] state from query:", state);
  logger.debug("[callback] nonce from session:", req.session.nonce);
  logger.debug("[callback] session ID:", req.sessionID);
  logger.info("[callback] hmac present:", !!hmac);

  if (state !== req.session.nonce) {
    logger.debug("[callback] STATE MISMATCH \u2014 query state:", JSON.stringify(state), "session nonce:", JSON.stringify(req.session.nonce));
    return res.status(403).send("State mismatch \u2014 possible CSRF attack.");
  }

  if (!hmac || !verifyHmac(req.query)) {
    logger.info("[callback] HMAC FAILED");
    return res.status(403).send("HMAC validation failed.");
  }

  logger.info("[callback] validation passed, exchanging token...");

  try {
    const tokenBody = new URLSearchParams({
      client_id: config.SHOPIFY_API_KEY,
      client_secret: config.SHOPIFY_API_SECRET,
      code,
    });

    logger.info("[token] POST https://%s/admin/oauth/access_token", shop);

    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });

    const tokenText = await tokenRes.text();
    logger.info("[token] status:", tokenRes.status);
    logger.debug("[token] response length:", tokenText.length);

    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed (${tokenRes.status}): ${tokenText.substring(0, 200)}`);
    }

    const { access_token } = JSON.parse(tokenText);

    setShopToken(shop, access_token);

    const storeSlug = shop.replace(".myshopify.com", "");
    const adminUrl = `https://admin.shopify.com/store/${storeSlug}/apps/${config.APP_HANDLE}`;
    logger.info("[callback] redirecting to admin");
    res.redirect(adminUrl);
  } catch (err) {
    logger.error("OAuth callback error:", err);
    res.status(500).send("Authentication failed. Please try again, or contact support if the problem persists.");
  }
});

module.exports = router;
