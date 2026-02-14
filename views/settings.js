const config = require("../lib/config");
const { escapeHtml } = require("./helpers");

function buildSettingsHtml(shop) {
  const shopParam = encodeURIComponent(shop);
  const metaConfigured = !!(config.META_SYSTEM_USER_TOKEN && config.META_AD_ACCOUNT_ID);
  const gaConfigured = !!(config.GA_PROPERTY_ID && config.GA_SERVICE_ACCOUNT_JSON);
  const claudeConfigured = !!config.ANTHROPIC_API_KEY;

  const accountIdDisplay = config.META_AD_ACCOUNT_ID
    ? (config.META_AD_ACCOUNT_ID.length > 10 ? config.META_AD_ACCOUNT_ID.substring(0, 10) + "\u2026" : config.META_AD_ACCOUNT_ID)
    : "";

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Settings \u2014 Data Sources</title>
      <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
      <script>
        shopify.config = {
          apiKey: ${JSON.stringify(config.SHOPIFY_API_KEY)},
          host: new URLSearchParams(window.location.search).get("host")
            || btoa(${JSON.stringify(shop + "/admin")}),
        };
      </script>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f6f6f7; color: #1a1a1a; }
        .topbar { background: #1a1a1a; color: #fff; padding: 16px 32px; display: flex; justify-content: space-between; align-items: center; }
        .topbar h1 { font-size: 18px; font-weight: 600; }
        .topbar nav { display: flex; gap: 20px; }
        .topbar a { color: #b5b5b5; text-decoration: none; font-size: 14px; }
        .topbar a:hover { color: #fff; }
        .topbar a.active { color: #fff; }
        .container { max-width: 720px; margin: 32px auto; padding: 0 24px; }
        .settings-title { font-size: 20px; font-weight: 600; margin-bottom: 20px; color: #1a1a1a; }
        .source-card { background: #fff; border-radius: 14px; padding: 20px 24px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); border: 1px solid #e5e7eb; display: flex; align-items: center; gap: 16px; }
        .source-card.connected { border-left: 4px solid #10b981; }
        .source-card.disconnected { border-left: 4px solid #d1d5db; opacity: 0.7; }
        .source-card-icon { font-size: 28px; width: 48px; height: 48px; border-radius: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .icon-shopify { background: #96bf48; color: #fff; font-size: 20px; font-weight: 700; }
        .icon-ga { background: #e37400; color: #fff; font-size: 20px; font-weight: 700; }
        .icon-meta { background: #1877f2; color: #fff; font-size: 20px; font-weight: 700; }
        .icon-claude { background: #d97706; color: #fff; font-size: 20px; font-weight: 700; }
        .source-card-body { flex: 1; }
        .source-card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
        .source-card-name { font-size: 16px; font-weight: 600; }
        .source-card-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
        .badge-connected { background: #dcfce7; color: #166534; }
        .badge-off { background: #f3f4f6; color: #6b7280; }
        .source-card-detail { font-size: 13px; color: #6b7280; line-height: 1.4; }
      </style>
    </head>
    <body>
      <div class="topbar">
        <h1>Shopify Dashboard</h1>
        <nav>
          <a href="/dashboard?shop=${shopParam}">Dashboard</a>
          <a href="/settings?shop=${shopParam}" class="active">Settings</a>
        </nav>
      </div>
      <div class="container">
        <div class="settings-title">Data Sources</div>

        <div class="source-card connected">
          <div class="source-card-icon icon-shopify">S</div>
          <div class="source-card-body">
            <div class="source-card-header">
              <span class="source-card-name">Shopify</span>
              <span class="source-card-badge badge-connected">\u2705 Connected</span>
            </div>
            <div class="source-card-detail">${escapeHtml(shop)}</div>
          </div>
        </div>

        <div class="source-card ${gaConfigured ? "connected" : "disconnected"}">
          <div class="source-card-icon icon-ga">G</div>
          <div class="source-card-body">
            <div class="source-card-header">
              <span class="source-card-name">Google Analytics</span>
              ${gaConfigured
                ? '<span class="source-card-badge badge-connected">\u2705 Connected</span>'
                : '<span class="source-card-badge badge-off">Not configured</span>'
              }
            </div>
            <div class="source-card-detail">${gaConfigured
              ? `Property ID: ${escapeHtml(config.GA_PROPERTY_ID)}<br>Service account active`
              : "Add GA_PROPERTY_ID and GA_SERVICE_ACCOUNT_JSON to env"
            }</div>
          </div>
        </div>

        <div class="source-card ${metaConfigured ? "connected" : "disconnected"}">
          <div class="source-card-icon icon-meta">f</div>
          <div class="source-card-body">
            <div class="source-card-header">
              <span class="source-card-name">Meta Ads</span>
              ${metaConfigured
                ? '<span class="source-card-badge badge-connected">\u2705 Connected</span>'
                : '<span class="source-card-badge badge-off">Not configured</span>'
              }
            </div>
            <div class="source-card-detail">${metaConfigured
              ? `System User connected<br>Account: ${escapeHtml(accountIdDisplay)}`
              : "Add META_SYSTEM_USER_TOKEN and META_AD_ACCOUNT_ID to env"
            }</div>
          </div>
        </div>

        <div class="source-card ${claudeConfigured ? "connected" : "disconnected"}">
          <div class="source-card-icon icon-claude">AI</div>
          <div class="source-card-body">
            <div class="source-card-header">
              <span class="source-card-name">Claude AI</span>
              ${claudeConfigured
                ? '<span class="source-card-badge badge-connected">\u2705 Connected</span>'
                : '<span class="source-card-badge badge-off">Not configured</span>'
              }
            </div>
            <div class="source-card-detail">${claudeConfigured
              ? "Generating business insights"
              : "Add ANTHROPIC_API_KEY to env"
            }</div>
          </div>
        </div>

      </div>
    </body>
    </html>
  `;
}

module.exports = { buildSettingsHtml };
