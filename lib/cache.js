const logger = require("./logger");

// --- Token Store ---
const shopTokens = {};

function getShopToken(shop) {
  return shopTokens[shop] || null;
}

function setShopToken(shop, accessToken) {
  shopTokens[shop] = { accessToken, installedAt: Date.now() };
  logger.info("[store] saved token for", shop);
}

function deleteShopToken(shop) {
  delete shopTokens[shop];
  delete insightsCache[shop];
  delete orderDataCache[shop];
  logger.info("[store] deleted token for", shop);
}

// --- Insights Cache (24hr TTL) ---
const insightsCache = {};
const INSIGHTS_TTL = 24 * 60 * 60 * 1000;

function getCachedInsights(shop) {
  const cached = insightsCache[shop];
  if (!cached) return null;
  if (Date.now() - cached.generatedAt > INSIGHTS_TTL) return null;
  return cached;
}

function setCachedInsights(shop, data) {
  insightsCache[shop] = { ...data, generatedAt: Date.now() };
  logger.info("[cache] saved insights for", shop);
}

function clearInsightsCache(shop) {
  delete insightsCache[shop];
  logger.info("[cache] cleared insights for", shop);
}

// --- Order Data Cache (24hr TTL) ---
const orderDataCache = {};
const ORDER_DATA_TTL = 24 * 60 * 60 * 1000;

function getCachedOrderData(shop) {
  const cached = orderDataCache[shop];
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > ORDER_DATA_TTL) {
    delete orderDataCache[shop];
    return null;
  }
  return cached;
}

function setCachedOrderData(shop, data) {
  orderDataCache[shop] = { ...data, cachedAt: Date.now() };
  logger.info("[cache] saved order data for", shop);
}

function clearOrderDataCache(shop) {
  delete orderDataCache[shop];
  logger.info("[cache] cleared order data for", shop);
}

module.exports = {
  getShopToken, setShopToken, deleteShopToken,
  getCachedInsights, setCachedInsights, clearInsightsCache,
  getCachedOrderData, setCachedOrderData, clearOrderDataCache,
};
