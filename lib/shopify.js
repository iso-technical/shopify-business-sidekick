const crypto = require("crypto");
const config = require("./config");
const logger = require("./logger");
const { getCachedOrderData, setCachedOrderData } = require("./cache");

function buildRedirectUri() {
  return `${config.HOST}/auth/callback`;
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
    .createHmac("sha256", config.SHOPIFY_API_SECRET)
    .update(sorted)
    .digest("hex");

  logger.debug("[HMAC] message string:", sorted);
  logger.debug("[HMAC] received:", hmac);
  logger.debug("[HMAC] computed:", computed);

  if (Buffer.from(computed).length !== Buffer.from(hmac).length) {
    logger.debug("[HMAC] length mismatch — received:", hmac.length, "computed:", computed.length);
    return false;
  }

  const match = crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hmac));
  logger.debug("[HMAC] match:", match);
  return match;
}

async function shopifyFetch(shop, accessToken, endpoint) {
  const [path, query] = endpoint.split("?");
  const url = `https://${shop}/admin/api/${config.SHOPIFY_API_VERSION}/${path}.json${query ? "?" + query : ""}`;
  const headers = {
    "X-Shopify-Access-Token": accessToken,
    "Content-Type": "application/json",
  };

  logger.info("[api] GET", url);
  logger.debug("[api] token:", accessToken ? accessToken.substring(0, 6) + "..." : "MISSING");

  const res = await fetch(url, { headers });

  logger.info("[api] %s \u2192 %d", endpoint, res.status);

  if (!res.ok) {
    const errBody = await res.text();
    logger.debug("[api] error body:", errBody.substring(0, 200));
    throw new Error(`Shopify API error ${res.status}: ${errBody.substring(0, 200)}`);
  }

  return res.json();
}

async function fetchAllPaidOrders(shop, accessToken, sinceDate) {
  const allOrders = [];
  let url = `https://${shop}/admin/api/${config.SHOPIFY_API_VERSION}/orders.json?status=any&financial_status=paid&created_at_min=${encodeURIComponent(sinceDate)}&limit=250`;

  while (url) {
    logger.info("[api] GET", url.substring(0, 120) + "...");
    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Shopify API error ${res.status}: ${errBody.substring(0, 200)}`);
    }

    const data = await res.json();
    allOrders.push(...(data.orders || []));

    const linkHeader = res.headers.get("link");
    url = null;
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) {
        url = nextMatch[1];
      }
    }

    logger.info("[api] fetched page:", data.orders?.length || 0, "orders | total so far:", allOrders.length);
  }

  logger.info("[api] pagination complete \u2014 total paid orders:", allOrders.length);
  return allOrders;
}

async function getShopifyOrderData(shop, accessToken) {
  const cached = getCachedOrderData(shop);
  if (cached) {
    logger.info("[orders] using cached order data from", new Date(cached.cachedAt).toISOString());
    return cached;
  }

  logger.info("[orders] cache miss \u2014 paginating all paid orders...");
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const sinceDate = thirtyDaysAgo.toISOString();

  const countData = await shopifyFetch(shop, accessToken, `orders/count?status=any&created_at_min=${encodeURIComponent(sinceDate)}`);
  const orderCount = countData.count || 0;

  const allPaidOrders = await fetchAllPaidOrders(shop, accessToken, sinceDate);
  const paidOrderCount = allPaidOrders.length;
  const revenue = allPaidOrders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
  const avgOrderValue = paidOrderCount > 0 ? revenue / paidOrderCount : 0;

  logger.info("[orders] fetched:", orderCount, "orders |", paidOrderCount, "paid | revenue: \u00a3" + revenue.toFixed(2), "| AOV: \u00a3" + avgOrderValue.toFixed(2));

  const shopifyStats = { orderCount, revenue, avgOrderValue, sampleSize: paidOrderCount, revenueIsEstimated: false };

  const productMap = {};
  for (const order of allPaidOrders) {
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

  const orderData = { shopifyStats, topProducts };
  setCachedOrderData(shop, orderData);
  return orderData;
}

module.exports = {
  buildRedirectUri, generateNonce, verifyHmac,
  shopifyFetch, fetchAllPaidOrders, getShopifyOrderData,
};
