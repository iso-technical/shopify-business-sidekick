const config = require("../lib/config");
const { escapeHtml, formatTileHtml } = require("./helpers");

function getDashboardStyles() {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f6f6f7; color: #1a1a1a; }
    .topbar { background: #1a1a1a; color: #fff; padding: 16px 32px; display: flex; justify-content: space-between; align-items: center; }
    .topbar h1 { font-size: 18px; font-weight: 600; }
    .topbar nav { display: flex; gap: 20px; }
    .topbar a { color: #b5b5b5; text-decoration: none; font-size: 14px; }
    .topbar a:hover { color: #fff; }
    .topbar a.active { color: #fff; }
    .connected-bar { background: #008060; color: #fff; padding: 14px 32px; font-size: 15px; }
    .connected-bar strong { font-weight: 600; }
    .container { max-width: 960px; margin: 24px auto; padding: 0 24px; }
    .refresh-flash { background: #dcfce7; color: #166534; padding: 12px 20px; border-radius: 10px; font-size: 14px; font-weight: 500; margin-bottom: 12px; text-align: center; animation: fadeOut 3s ease-in-out forwards; }
    @keyframes fadeOut { 0%, 70% { opacity: 1; } 100% { opacity: 0; } }
    .freshness-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 8px; }
    .freshness-card { background: #fff; border-radius: 12px; padding: 16px; display: flex; gap: 12px; align-items: center; box-shadow: 0 1px 3px rgba(0,0,0,0.06); border: 1px solid #e5e7eb; }
    .freshness-card-off { opacity: 0.5; }
    .freshness-card-icon { font-size: 24px; }
    .freshness-card-body { flex: 1; }
    .freshness-card-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin-bottom: 2px; }
    .freshness-card-metric { font-size: 16px; font-weight: 700; color: #1a1a1a; }
    .freshness-card-metric.dim { font-weight: 400; color: #9ca3af; font-size: 13px; }
    .freshness-card-sub { font-size: 12px; color: #6b7280; margin-top: 1px; }
    .freshness-footer { font-size: 12px; color: #6b7280; text-align: center; padding: 8px 0 4px; margin-bottom: 16px; }
    .refresh-link { color: #008060; text-decoration: none; font-weight: 500; cursor: pointer; }
    .refresh-link:hover { text-decoration: underline; }
    .refresh-link.loading { pointer-events: none; color: #6b7280; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .refresh-link.loading .refresh-spin { display: inline-block; animation: spin 1s linear infinite; }
    .tile-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .tile { border-radius: 14px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
    .tile.full { grid-column: 1 / -1; }
    .tile-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
    .tile-body { font-size: 15px; line-height: 1.7; color: #374151; }
    .tile-body strong { color: #1a1a1a; font-weight: 600; }
    .tile-healthy { background: linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%); border: 1px solid #bbf7d0; }
    .tile-healthy .tile-label { color: #166534; }
    .tile-warning { background: linear-gradient(135deg, #fefce8 0%, #fef9c3 100%); border: 1px solid #fde68a; }
    .tile-warning .tile-label { color: #92400e; }
    .tile-critical { background: linear-gradient(135deg, #fef2f2 0%, #fff1f2 100%); border: 1px solid #fecaca; }
    .tile-critical .tile-label { color: #991b1b; }
    .tile-action { background: linear-gradient(135deg, #eff6ff 0%, #f0f9ff 100%); border: 1px solid #bfdbfe; }
    .tile-action .tile-label { color: #1e40af; }
    .tile-opportunity { background: linear-gradient(135deg, #fefce8 0%, #fef9c3 100%); border: 1px solid #fde68a; }
    .tile-opportunity .tile-label { color: #92400e; }
    .insights-error { background: #fff; border-radius: 14px; padding: 40px; text-align: center; color: #6b7280; font-size: 15px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
    .insights-error a { color: #008060; text-decoration: none; font-weight: 500; }
    .setup-card { background: #fff; border-radius: 14px; padding: 48px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
    .setup-card h2 { font-size: 18px; margin-bottom: 8px; }
    .setup-card p { color: #6b7280; font-size: 14px; line-height: 1.6; }
    .tile-skeleton { background: #fff; border: 1px solid #e5e7eb; }
    .skeleton-line { display: block; height: 14px; background: linear-gradient(90deg, #e5e7eb 25%, #f3f4f6 50%, #e5e7eb 75%); background-size: 200% 100%; border-radius: 4px; margin-bottom: 10px; animation: shimmer 1.5s ease-in-out infinite; }
    .skeleton-label { width: 100px; height: 12px; background: linear-gradient(90deg, #e5e7eb 25%, #f3f4f6 50%, #e5e7eb 75%); background-size: 200% 100%; border-radius: 4px; animation: shimmer 1.5s ease-in-out infinite; }
    @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .loading-status { text-align: center; padding: 20px 0 8px; font-size: 14px; color: #6b7280; font-weight: 500; margin-bottom: 16px; }
    .loading-dot { display: inline-block; width: 8px; height: 8px; background: #008060; border-radius: 50%; margin-right: 8px; vertical-align: middle; animation: pulse 1.5s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    .auto-refresh-banner { max-width: 960px; margin: 12px auto 0; padding: 10px 20px; border-radius: 10px; font-size: 14px; font-weight: 500; text-align: center; transition: opacity 0.3s ease; }
    .auto-refresh-banner a { color: inherit; font-weight: 600; text-decoration: underline; }
    .arb-loading { background: #dbeafe; color: #1e40af; }
    .arb-success { background: #dcfce7; color: #166534; }
    .arb-error { background: #fef3c7; color: #92400e; }
    @media (max-width: 640px) {
      .tile-grid { grid-template-columns: 1fr; }
      .tile.full { grid-column: 1; }
      .freshness-cards { grid-template-columns: 1fr; }
    }
  `;
}

function buildContentHtml(insightsData, shop) {
  const shopParam = encodeURIComponent(shop);
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const dateFrom = thirtyDaysAgo.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
  const dateTo = now.toLocaleDateString("en-GB", { month: "short", day: "numeric", year: "numeric" });
  const dateRange = `${dateFrom} - ${dateTo}`;

  const justRefreshed = insightsData.generatedAt && (Date.now() - insightsData.generatedAt < 5000);
  const stats = insightsData.shopifyStats;
  const ga = insightsData.gaData;
  const meta = insightsData.metaAdsData;
  const updatedAt = new Date(insightsData.generatedAt);
  const timeStr = updatedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const isToday = updatedAt.toDateString() === now.toDateString();
  const updatedLabel = isToday ? `Today at ${timeStr}` : updatedAt.toLocaleDateString("en-GB", { month: "short", day: "numeric" }) + ` at ${timeStr}`;

  const metaRoas = meta && meta.spend > 0 ? (meta.revenue / meta.spend).toFixed(2) : null;
  const ordersPerDay = Math.round(stats.orderCount / 30);
  const orderTrend = ordersPerDay > 100 ? "\ud83d\udcc8" : ordersPerDay < 50 ? "\ud83d\udcc9" : "\u27a1\ufe0f";

  let bounceInsight = "";
  if (ga) {
    const br = ga.bounceRate * 100;
    if (br < 40) bounceInsight = "Great engagement \u2705";
    else if (br <= 65) bounceInsight = "Bounce OK \u27a1\ufe0f";
    else bounceInsight = "High bounce \u26a0\ufe0f";
  }

  let html = justRefreshed ? '<div class="refresh-flash">\u2705 Insights refreshed</div>' : "";
  html += `
    <div class="freshness-cards">
      <div class="freshness-card">
        <div class="freshness-card-icon">\ud83d\uded2</div>
        <div class="freshness-card-body">
          <div class="freshness-card-title">Shopify</div>
          <div class="freshness-card-metric">${stats.orderCount.toLocaleString()} orders &middot; ${ordersPerDay}/day ${orderTrend}</div>
          <div class="freshness-card-sub">${dateRange}</div>
        </div>
      </div>
      <div class="freshness-card${ga ? "" : " freshness-card-off"}">
        <div class="freshness-card-icon">\ud83d\udcca</div>
        <div class="freshness-card-body">
          <div class="freshness-card-title">Analytics</div>
          ${ga
            ? `<div class="freshness-card-metric">${ga.sessions.toLocaleString()} sessions</div>
               <div class="freshness-card-sub">${bounceInsight}</div>`
            : `<div class="freshness-card-metric dim">Not connected</div>`
          }
        </div>
      </div>
      <div class="freshness-card${meta ? "" : " freshness-card-off"}">
        <div class="freshness-card-icon">\ud83d\udcf1</div>
        <div class="freshness-card-body">
          <div class="freshness-card-title">Meta Ads</div>
          ${meta
            ? `<div class="freshness-card-metric">\u00a3${meta.spend.toFixed(0)} spend</div>
               <div class="freshness-card-sub">${metaRoas !== null ? metaRoas + "x ROAS" : "No spend this period"}</div>`
            : `<div class="freshness-card-metric dim">Not connected</div>`
          }
        </div>
      </div>
    </div>
    <div class="freshness-footer">
      Last updated: ${escapeHtml(updatedLabel)} &middot; <a href="/dashboard?shop=${shopParam}&refresh=1" class="refresh-link" id="refresh-btn" onclick="this.classList.add('loading');this.textContent='Refreshing\\u2026';">\u2728 Refresh</a>
    </div>`;

  const tiles = insightsData.tiles;
  const hasTiles = tiles && (tiles.healthCheck || tiles.biggestIssue || tiles.quickWin || tiles.opportunity || tiles.adPerformance);

  if (!hasTiles) {
    html += `<div class="insights-error">Unable to generate insights. <a href="/dashboard?shop=${shopParam}&refresh=1">Try again</a></div>`;
    return html;
  }

  const healthClass = ({ healthy: "tile-healthy", warning: "tile-warning", critical: "tile-critical" }[tiles.healthSeverity] || "tile-healthy");
  const adClass = ({ healthy: "tile-healthy", warning: "tile-warning", critical: "tile-critical" }[tiles.adSeverity] || "tile-healthy");

  const statusEmojis = ["\ud83d\udfe2", "\ud83d\udfe1", "\ud83d\udd34"];
  let healthEmoji = "\ud83c\udfe5";
  let healthBody = tiles.healthCheck || "";
  const hMatch = statusEmojis.find(e => tiles.healthCheck.startsWith(e));
  if (hMatch) { healthEmoji = hMatch; healthBody = tiles.healthCheck.slice(hMatch.length).trim(); }

  let adEmoji = "\ud83d\udcb0";
  let adBody = tiles.adPerformance || "";
  if (tiles.adPerformance) {
    const aMatch = statusEmojis.find(e => tiles.adPerformance.startsWith(e));
    if (aMatch) { adEmoji = aMatch; adBody = tiles.adPerformance.slice(aMatch.length).trim(); }
  }

  html += `
    <div class="tile-grid">
      <div class="tile ${healthClass} full">
        <div class="tile-label">${healthEmoji} Health Check</div>
        <div class="tile-body">${formatTileHtml(healthBody)}</div>
      </div>
      <div class="tile tile-critical">
        <div class="tile-label">\ud83d\udea8 Biggest Issue</div>
        <div class="tile-body">${formatTileHtml(tiles.biggestIssue)}</div>
      </div>
      <div class="tile tile-action">
        <div class="tile-label">\u26a1 Quick Win</div>
        <div class="tile-body">${formatTileHtml(tiles.quickWin)}</div>
      </div>
      <div class="tile tile-opportunity full">
        <div class="tile-label">\ud83c\udf1f Opportunity</div>
        <div class="tile-body">${formatTileHtml(tiles.opportunity)}</div>
      </div>
      ${tiles.adPerformance ? `
      <div class="tile ${adClass} full">
        <div class="tile-label">${adEmoji} Ad Performance</div>
        <div class="tile-body">${formatTileHtml(adBody)}</div>
      </div>
      ` : ""}
    </div>`;

  return html;
}

function buildSkeletonHtml(storeName, shop) {
  const shopParam = encodeURIComponent(shop);
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Dashboard \u2014 ${escapeHtml(storeName)}</title>
      <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
      <script>
        shopify.config = {
          apiKey: ${JSON.stringify(config.SHOPIFY_API_KEY)},
          host: new URLSearchParams(window.location.search).get("host")
            || btoa(${JSON.stringify(shop + "/admin")}),
        };
      </script>
      <style>${getDashboardStyles()}</style>
    </head>
    <body>
      <div class="topbar">
        <h1>Shopify Dashboard</h1>
        <nav>
          <a href="/dashboard?shop=${shopParam}" class="active">Dashboard</a>
          <a href="/settings?shop=${shopParam}">Settings</a>
        </nav>
      </div>
      <div class="connected-bar">Connected to: <strong>${escapeHtml(storeName)}</strong> (${escapeHtml(shop)})</div>
      <div class="container" id="dashboard-content">
        <div class="freshness-cards">
          <div class="freshness-card">
            <div class="freshness-card-icon" style="opacity:0.3">\ud83d\uded2</div>
            <div class="freshness-card-body">
              <div class="skeleton-line" style="width:60px"></div>
              <div class="skeleton-line" style="width:130px;margin:0"></div>
            </div>
          </div>
          <div class="freshness-card">
            <div class="freshness-card-icon" style="opacity:0.3">\ud83d\udcca</div>
            <div class="freshness-card-body">
              <div class="skeleton-line" style="width:70px"></div>
              <div class="skeleton-line" style="width:110px;margin:0"></div>
            </div>
          </div>
          <div class="freshness-card">
            <div class="freshness-card-icon" style="opacity:0.3">\ud83d\udcf1</div>
            <div class="freshness-card-body">
              <div class="skeleton-line" style="width:65px"></div>
              <div class="skeleton-line" style="width:95px;margin:0"></div>
            </div>
          </div>
        </div>
        <div class="loading-status" id="loading-status">
          <span class="loading-dot"></span> Connecting to your store\u2026
        </div>
        <div class="tile-grid">
          <div class="tile tile-skeleton full">
            <div class="tile-label"><span class="skeleton-label"></span></div>
            <div class="tile-body">
              <span class="skeleton-line" style="width:92%"></span>
              <span class="skeleton-line" style="width:75%"></span>
              <span class="skeleton-line" style="width:55%"></span>
            </div>
          </div>
          <div class="tile tile-skeleton">
            <div class="tile-label"><span class="skeleton-label"></span></div>
            <div class="tile-body">
              <span class="skeleton-line" style="width:88%"></span>
              <span class="skeleton-line" style="width:65%"></span>
            </div>
          </div>
          <div class="tile tile-skeleton">
            <div class="tile-label"><span class="skeleton-label"></span></div>
            <div class="tile-body">
              <span class="skeleton-line" style="width:82%"></span>
              <span class="skeleton-line" style="width:60%"></span>
            </div>
          </div>
          <div class="tile tile-skeleton full">
            <div class="tile-label"><span class="skeleton-label"></span></div>
            <div class="tile-body">
              <span class="skeleton-line" style="width:90%"></span>
              <span class="skeleton-line" style="width:70%"></span>
            </div>
          </div>
        </div>
      </div>
      <script>
        window.__li = setInterval(function() {
          var el = document.getElementById("loading-status");
          var msgs = ["Connecting to your store\\u2026","Fetching order data\\u2026","Pulling analytics\\u2026","Generating AI insights\\u2026","Almost ready\\u2026"];
          if (!window.__mi) window.__mi = 0;
          window.__mi = Math.min(window.__mi + 1, msgs.length - 1);
          if (el) el.innerHTML = '<span class="loading-dot"></span> ' + msgs[window.__mi];
        }, 3000);
        window.__lt = setTimeout(function() {
          if (window.__li) clearInterval(window.__li);
          var el = document.getElementById("loading-status");
          if (el) el.innerHTML = '\\u26a0\\ufe0f Loading is taking too long. <a href="/dashboard?shop=${shopParam}&refresh=1">Try again</a>';
        }, 60000);
      </script>
  `;
}

function buildDashboardHtml(storeName, shop, insightsData) {
  const shopParam = encodeURIComponent(shop);

  // Auto-refresh: if cached data is from before today, refresh in background
  let autoRefreshScript = "";
  if (insightsData) {
    autoRefreshScript = `
      <script>
      (function() {
        var ts = ${insightsData.generatedAt};
        var today = new Date(); today.setHours(0,0,0,0);
        if (ts >= today.getTime()) return;
        var b = document.getElementById('auto-refresh-banner');
        b.className = 'auto-refresh-banner arb-loading';
        b.innerHTML = '<span class="loading-dot"></span> \ud83d\udcca Updating to today\u2019s data\u2026';
        b.style.display = '';
        fetch('/dashboard/refresh?shop=${shopParam}')
          .then(function(r) {
            if (r.status === 401) { window.location.replace('/install?shop=${shopParam}&error=token_expired'); throw new Error('auth'); }
            if (!r.ok) throw new Error(r.status);
            return r.json();
          })
          .then(function(d) {
            var c = document.getElementById('dashboard-content');
            if (c) c.innerHTML = d.html;
            var f = c && c.querySelector('.refresh-flash'); if (f) f.remove();
            b.className = 'auto-refresh-banner arb-success';
            b.textContent = '\u2705 Dashboard updated';
            setTimeout(function() { b.style.opacity = '0'; setTimeout(function() { b.style.display = 'none'; }, 300); }, 3000);
          })
          .catch(function(e) {
            if (e.message === 'auth') return;
            b.className = 'auto-refresh-banner arb-error';
            b.textContent = '';
            b.appendChild(document.createTextNode('\u26a0\ufe0f Couldn\u2019t refresh automatically. '));
            var a = document.createElement('a');
            a.href = '/dashboard?shop=${shopParam}&refresh=1';
            a.className = 'refresh-link';
            a.textContent = 'Tap Refresh to retry.';
            b.appendChild(a);
          });
      })();
      </script>`;
  }

  let contentHtml;
  if (insightsData) {
    contentHtml = buildContentHtml(insightsData, shop);
  } else if (!config.ANTHROPIC_API_KEY) {
    contentHtml = `
      <div class="setup-card">
        <h2>Add your Anthropic API key to get started</h2>
        <p>Set ANTHROPIC_API_KEY in your environment variables to enable AI-powered store insights.</p>
      </div>`;
  } else {
    contentHtml = `
      <div class="insights-error">
        Unable to generate insights. <a href="/dashboard?shop=${shopParam}&refresh=1">Try again</a>
      </div>`;
  }

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Dashboard \u2014 ${escapeHtml(storeName)}</title>
      <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
      <script>
        shopify.config = {
          apiKey: ${JSON.stringify(config.SHOPIFY_API_KEY)},
          host: new URLSearchParams(window.location.search).get("host")
            || btoa(${JSON.stringify(shop + "/admin")}),
        };
      </script>
      <style>${getDashboardStyles()}</style>
    </head>
    <body>
      <div class="topbar">
        <h1>Shopify Dashboard</h1>
        <nav>
          <a href="/dashboard?shop=${shopParam}" class="active">Dashboard</a>
          <a href="/settings?shop=${shopParam}">Settings</a>
        </nav>
      </div>
      <div class="connected-bar">Connected to: <strong>${escapeHtml(storeName)}</strong> (${escapeHtml(shop)})</div>
      <div id="auto-refresh-banner" style="display:none"></div>
      <div class="container" id="dashboard-content">
        ${contentHtml}
      </div>
      ${autoRefreshScript}
    </body>
    </html>
  `;
}

module.exports = { getDashboardStyles, buildContentHtml, buildSkeletonHtml, buildDashboardHtml };
