const config = require("./config");
const logger = require("./logger");

async function fetchMetaAdsData() {
  if (!config.META_SYSTEM_USER_TOKEN || !config.META_AD_ACCOUNT_ID) {
    logger.info("[meta-api] skipping \u2014 META_SYSTEM_USER_TOKEN or META_AD_ACCOUNT_ID not set");
    return null;
  }

  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const since = thirtyDaysAgo.toISOString().split("T")[0];
  const until = today.toISOString().split("T")[0];

  const accountId = config.META_AD_ACCOUNT_ID.startsWith("act_")
    ? config.META_AD_ACCOUNT_ID
    : `act_${config.META_AD_ACCOUNT_ID}`;
  const timeRange = JSON.stringify({ since, until });
  const fields = "spend,impressions,clicks,actions,action_values";
  const url =
    `https://graph.facebook.com/${config.META_API_VERSION}/${accountId}/insights` +
    `?access_token=${encodeURIComponent(config.META_SYSTEM_USER_TOKEN)}` +
    `&time_range=${encodeURIComponent(timeRange)}` +
    `&fields=${fields}` +
    `&level=account`;

  logger.info("[meta-api] fetching ad insights for account:", config.META_AD_ACCOUNT_ID);
  logger.info("[meta-api] date range:", since, "to", until);

  const res = await fetch(url);
  const data = await res.json();

  logger.info("[meta-api] response status:", res.status);

  if (data.error) {
    logger.error("[meta-api] API error:", data.error.message);
    throw new Error(`Meta Ads API error: ${data.error.message}`);
  }

  const row = data.data?.[0];
  if (!row) {
    logger.info("[meta-api] no ad data returned (no active campaigns?)");
    return { spend: 0, impressions: 0, clicks: 0, purchases: 0, revenue: 0 };
  }

  const actions = row.actions || [];
  const purchaseAction = actions.find(a => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase");
  const purchases = purchaseAction ? parseInt(purchaseAction.value, 10) : 0;

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

  logger.info("[meta-api] data:", result);
  return result;
}

module.exports = { fetchMetaAdsData };
