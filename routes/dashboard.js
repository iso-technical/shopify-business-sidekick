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

// JSON endpoint for client-side auto-refresh (stale data from previous day)
router.get("/dashboard/refresh", async (req, res) => {
  const shop = req.query.shop;
  const tokenData = shop ? getShopToken(shop) : null;

  if (!shop || !tokenData) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const { accessToken } = tokenData;

  try {
    clearInsightsCache(shop);
    clearOrderDataCache(shop);

    const [shopData, orderData, gaData, metaAdsData] = await Promise.all([
      shopifyFetch(shop, accessToken, "shop"),
      getShopifyOrderData(shop, accessToken),
      fetchGoogleAnalyticsData().catch(err => { logger.info("[auto-refresh] GA failed:", err.message); return null; }),
      fetchMetaAdsData().catch(err => { logger.info("[auto-refresh] Meta failed:", err.message); return null; }),
    ]);

    const tiles = await generateTileInsights(orderData.shopifyStats, gaData, metaAdsData, orderData.topProducts);
    setCachedInsights(shop, { tiles, shopifyStats: orderData.shopifyStats, gaData, metaAdsData });

    const cached = getCachedInsights(shop);
    const contentHtml = buildContentHtml(cached, shop);

    logger.info("[auto-refresh] completed for", shop);
    res.json({ html: contentHtml, storeName: shopData.shop.name });
  } catch (err) {
    logger.error("[auto-refresh] error:", err.message);
    if (err.message.includes("401")) {
      deleteShopToken(shop);
      return res.status(401).json({ error: "token_expired" });
    }
    res.status(500).json({ error: err.message });
  }
});

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
    const forceRefresh = req.query.refresh === "1";

    // Force refresh clears both caches so order data is also re-fetched
    if (forceRefresh) {
      clearInsightsCache(shop);
      clearOrderDataCache(shop);
    }

    // Check cache BEFORE any API calls — avoids blocking on shopifyFetch for cache misses
    let insightsData = null;
    if (config.ANTHROPIC_API_KEY && !forceRefresh) {
      insightsData = getCachedInsights(shop);
      if (insightsData) {
        logger.info("[dashboard] cache hit from", new Date(insightsData.generatedAt).toISOString());
      }
    }

    // Cache hit or no API key — fetch store name then render full page
    if (insightsData || !config.ANTHROPIC_API_KEY) {
      const shopData = await shopifyFetch(shop, accessToken, "shop");
      const storeName = shopData.shop.name;
      logger.info("[dashboard] rendering full page (cached:", !!insightsData, ")");
      return res.send(buildDashboardHtml(storeName, shop, insightsData));
    }

    // Cache miss — send skeleton IMMEDIATELY before any data fetching
    logger.info("[dashboard] cache miss \u2014 streaming skeleton + generating insights");
    const placeholderName = shop.replace(".myshopify.com", "")
      .split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.flushHeaders();
    res.write(buildSkeletonHtml(placeholderName, shop));

    try {
      // Fetch store name, order data, GA, and Meta all in parallel
      const [shopData, orderData, gaData, metaAdsData] = await Promise.all([
        shopifyFetch(shop, accessToken, "shop"),
        getShopifyOrderData(shop, accessToken),
        fetchGoogleAnalyticsData().catch(err => { logger.info("[dashboard] GA failed:", err.message); return null; }),
        fetchMetaAdsData().catch(err => { logger.info("[dashboard] Meta failed:", err.message); return null; }),
      ]);

      const storeName = shopData.shop.name;
      const tiles = await generateTileInsights(orderData.shopifyStats, gaData, metaAdsData, orderData.topProducts);
      const newInsights = { tiles, shopifyStats: orderData.shopifyStats, gaData, metaAdsData };
      setCachedInsights(shop, newInsights);

      const cached = getCachedInsights(shop);
      const contentHtml = buildContentHtml(cached, shop);

      // Swap content, update store name in topbar/title, and clear loading timers
      const safeStoreName = JSON.stringify(storeName);
      res.write("<script>(function(){" +
        "var c=document.getElementById('dashboard-content');if(c)c.innerHTML=" + JSON.stringify(contentHtml) + ";" +
        "document.title='Dashboard \\u2014 '+" + safeStoreName + ";" +
        "var b=document.querySelector('.connected-bar');if(b)b.innerHTML='Connected to: <strong>'+" + safeStoreName + "+'</strong> (" + shop.replace(/'/g, "\\'") + ")';" +
        "if(window.__li)clearInterval(window.__li);if(window.__lt)clearTimeout(window.__lt);" +
        "})();</script>");
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
