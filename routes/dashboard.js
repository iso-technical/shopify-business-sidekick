const express = require("express");
const router = express.Router();
const config = require("../lib/config");
const logger = require("../lib/logger");
const { getShopToken, deleteShopToken, getCachedInsights, setCachedInsights, clearInsightsCache, clearOrderDataCache } = require("../lib/cache");
const { shopifyFetch, getShopifyOrderData } = require("../lib/shopify");
const { fetchGoogleAnalyticsData } = require("../lib/analytics");
const { fetchMetaAdsData } = require("../lib/meta");
const { generateTileInsights } = require("../lib/insights");
const { buildDashboardHtml, buildSkeletonHtml, buildContentHtml } = require("../views/dashboard");

router.get("/dashboard", async (req, res) => {
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
    logger.info("[dashboard] fetching data for shop:", shop);
    const shopData = await shopifyFetch(shop, accessToken, "shop");
    const storeName = shopData.shop.name;
    const forceRefresh = req.query.refresh === "1";

    // Force refresh clears both caches so order data is also re-fetched
    if (forceRefresh) {
      clearInsightsCache(shop);
      clearOrderDataCache(shop);
    }

    let insightsData = null;
    if (config.ANTHROPIC_API_KEY && !forceRefresh) {
      insightsData = getCachedInsights(shop);
      if (insightsData) {
        logger.info("[dashboard] cache hit from", new Date(insightsData.generatedAt).toISOString());
      }
    }

    // Cache hit or no API key — render full page immediately
    if (insightsData || !config.ANTHROPIC_API_KEY) {
      logger.info("[dashboard] rendering full page (cached:", !!insightsData, ")");
      return res.send(buildDashboardHtml(storeName, shop, insightsData));
    }

    // Cache miss — stream skeleton page, then swap in real content when ready
    logger.info("[dashboard] cache miss \u2014 streaming skeleton + generating insights");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.flushHeaders();

    res.write(buildSkeletonHtml(storeName, shop));

    try {
      const orderData = await getShopifyOrderData(shop, accessToken);

      const [gaData, metaAdsData] = await Promise.all([
        fetchGoogleAnalyticsData().catch(err => { logger.info("[dashboard] GA failed:", err.message); return null; }),
        fetchMetaAdsData().catch(err => { logger.info("[dashboard] Meta failed:", err.message); return null; }),
      ]);

      const tiles = await generateTileInsights(orderData.shopifyStats, gaData, metaAdsData, orderData.topProducts);
      const newInsights = { tiles, shopifyStats: orderData.shopifyStats, gaData, metaAdsData };
      setCachedInsights(shop, newInsights);

      const cached = getCachedInsights(shop);
      const contentHtml = buildContentHtml(cached, shop);
      res.write("<script>(function(){var c=document.getElementById('dashboard-content');if(c)c.innerHTML=" + JSON.stringify(contentHtml) + ";if(window.__li)clearInterval(window.__li);if(window.__lt)clearTimeout(window.__lt);})();</script>");
      logger.info("[dashboard] streamed real content");
    } catch (genErr) {
      logger.error("[dashboard] generation error:", genErr.message);
      if (genErr.message.includes("401")) {
        deleteShopToken(shop);
        res.write("<script>window.location.replace('/install?shop=" + encodeURIComponent(shop) + "&error=token_expired');</script>");
      } else {
        res.write("<script>(function(){if(window.__li)clearInterval(window.__li);if(window.__lt)clearTimeout(window.__lt);var el=document.getElementById('loading-status');if(el)el.innerHTML='\\u26a0\\ufe0f Failed to generate insights. <a href=\"/dashboard?shop=" + encodeURIComponent(shop) + "&refresh=1\">Try again</a>';})();</script>");
      }
    }

    res.write("</body></html>");
    res.end();
  } catch (err) {
    logger.error("Dashboard error:", err);
    if (err.message.includes("401")) {
      deleteShopToken(shop);
      return res.redirect(`/install?shop=${encodeURIComponent(shop)}&error=token_expired`);
    }
    res.status(500).send("Failed to load dashboard. Please try again, or contact support if the problem persists.");
  }
});

module.exports = router;
