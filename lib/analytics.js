const config = require("./config");
const logger = require("./logger");

async function fetchGoogleAnalyticsData() {
  logger.info("[ga-auth] GA_PROPERTY_ID:", config.GA_PROPERTY_ID || "(not set)");
  logger.debug("[ga-auth] GA_SERVICE_ACCOUNT_JSON exists:", !!config.GA_SERVICE_ACCOUNT_JSON);
  logger.debug("[ga-auth] GA_SERVICE_ACCOUNT_JSON length:", config.GA_SERVICE_ACCOUNT_JSON?.length || 0);

  if (!config.GA_PROPERTY_ID || !config.GA_SERVICE_ACCOUNT_JSON) {
    logger.info("[ga-auth] aborting \u2014 missing config");
    return null;
  }

  const { google } = require("googleapis");

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(config.GA_SERVICE_ACCOUNT_JSON);
    logger.info("[ga-auth] parsed JSON successfully");
    logger.debug("[ga-auth] client_email:", serviceAccount.client_email || "(missing)");
    logger.debug("[ga-auth] private_key present:", !!serviceAccount.private_key);
    logger.debug("[ga-auth] private_key length:", serviceAccount.private_key?.length || 0);
    logger.debug("[ga-auth] project_id:", serviceAccount.project_id || "(missing)");
  } catch (err) {
    logger.error("[ga-auth] failed to parse GA_SERVICE_ACCOUNT_JSON:", err.message);
    logger.debug("[ga-auth] first 100 chars:", config.GA_SERVICE_ACCOUNT_JSON.substring(0, 100));
    return null;
  }

  logger.debug("[ga-auth] creating GoogleAuth with credentials...");
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  });
  logger.debug("[ga-auth] GoogleAuth created successfully");

  const analyticsData = google.analyticsdata({ version: "v1beta", auth });

  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const formatDate = (d) => d.toISOString().split("T")[0];

  logger.info("[ga] fetching data for property:", config.GA_PROPERTY_ID);
  logger.info("[ga] date range:", formatDate(thirtyDaysAgo), "to", formatDate(today));

  const res = await analyticsData.properties.runReport({
    property: `properties/${config.GA_PROPERTY_ID}`,
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

  const metadata = res.data.metadata;
  if (metadata) {
    if (metadata.dataLossFromOtherRow) logger.warn("[ga] WARNING: dataLossFromOtherRow =", metadata.dataLossFromOtherRow);
    if (metadata.samplingMetadatas?.length) logger.warn("[ga] WARNING: response is SAMPLED:", JSON.stringify(metadata.samplingMetadatas));
    if (metadata.schemaRestrictionResponse) logger.warn("[ga] WARNING: schema restriction (thresholding):", JSON.stringify(metadata.schemaRestrictionResponse));
  }
  logger.info("[ga] row count:", res.data.rows?.length || 0);
  logger.debug("[ga] rowCount (from API):", res.data.rowCount);

  const row = res.data.rows?.[0];
  if (!row) {
    logger.info("[ga] no data returned");
    return { sessions: 0, pageViews: 0, users: 0, bounceRate: 0 };
  }

  const metrics = {
    sessions: parseInt(row.metricValues[0].value, 10),
    pageViews: parseInt(row.metricValues[1].value, 10),
    users: parseInt(row.metricValues[2].value, 10),
    bounceRate: parseFloat(row.metricValues[3].value),
  };

  logger.info("[ga] data:", metrics);
  return metrics;
}

module.exports = { fetchGoogleAnalyticsData };
