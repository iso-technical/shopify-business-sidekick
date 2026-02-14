const express = require("express");
const router = express.Router();
const config = require("../lib/config");
const logger = require("../lib/logger");
const { getShopToken } = require("../lib/cache");
const { getShopifyOrderData } = require("../lib/shopify");
const { fetchGoogleAnalyticsData } = require("../lib/analytics");
const { fetchMetaAdsData } = require("../lib/meta");
const { generateTileInsights } = require("../lib/insights");

// AI Insights — fetch Shopify + GA data and generate Claude analysis
router.get("/insights", async (req, res) => {
  const shop = req.query.shop;
  const tokenData = shop ? getShopToken(shop) : null;

  if (!shop || !tokenData) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  if (!config.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  try {
    const { accessToken } = tokenData;

    const orderData = await getShopifyOrderData(shop, accessToken);
    logger.info("[insights] shopify stats:", orderData.shopifyStats);

    const [gaData, metaAdsData] = await Promise.all([
      fetchGoogleAnalyticsData().catch(err => { logger.info("[insights] GA failed:", err.message); return null; }),
      fetchMetaAdsData().catch(err => { logger.info("[insights] Meta failed:", err.message); return null; }),
    ]);

    const tiles = await generateTileInsights(orderData.shopifyStats, gaData, metaAdsData, orderData.topProducts);

    res.json({
      shopifyStats: orderData.shopifyStats,
      gaData,
      metaAdsData,
      tiles,
    });
  } catch (err) {
    logger.error("[insights] error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Test Google Analytics — development only
if (config.isDevelopment) {
  router.get("/test-ga", async (_req, res) => {
    try {
      const data = await fetchGoogleAnalyticsData();
      if (!data) {
        return res.status(500).send(
          "Google Analytics not configured. Set GA_PROPERTY_ID and GA_SERVICE_ACCOUNT_JSON in .env"
        );
      }
      res.json({
        status: "ok",
        propertyId: config.GA_PROPERTY_ID,
        period: "last 30 days",
        metrics: data,
      });
    } catch (err) {
      logger.error("[test-ga] error:", err);
      res.status(500).json({
        status: "error",
        message: err.message,
      });
    }
  });
}

// Health check for Railway
router.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

module.exports = router;
