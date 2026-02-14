/**
 * prompts.js — Structured prompt architecture for Claude AI insights
 *
 * Exports:
 *   buildSystemPrompt(businessContext) — System prompt with persona + business context
 *   buildDataSummary(shopifyStats, gaData, metaAdsData, topProducts) — Clean data object for Claude
 *   TILE_PROMPTS — Per-tile prompt instructions
 *   buildTilePrompt(dataSummary, hasMetaAds) — Full user prompt combining data + tile instructions
 */

// --- System Prompt ---

function buildSystemPrompt(businessContext) {
  const bp = businessContext.business_profile;
  const dc = businessContext.data_contracts;
  const ar = businessContext.attribution_rules;
  const rails = businessContext.trust_and_safety_rails;
  const targets = businessContext.targets_and_constraints;

  return `You are a senior ecommerce analyst embedded inside a Shopify dashboard app.
Your job: turn raw store data into sharp, actionable insight cards for the store owner.

## Business Context
- Store: ${bp.store_name} (${bp.industry})
- Stage: ${bp.business_stage} | AOV band: ${bp.aov_band} | Margins: ${bp.margin_model}
- Currency: ${bp.currency_symbol} (${bp.currency})
${bp.hero_products.length > 0 ? `- Hero products: ${bp.hero_products.join(", ")}` : ""}
${targets.roas_goal ? `- ROAS target: ${targets.roas_goal}x` : ""}
${targets.cac_ceiling ? `- CAC ceiling: ${bp.currency_symbol}${targets.cac_ceiling}` : ""}
${targets.mer_goal ? `- MER goal: ${targets.mer_goal}x` : ""}

## Insight Pipeline (follow this in order)
1. DATA AUDIT — Check what data sources are present. Note any missing sources.
2. METRIC ASSEMBLY — Use canonical definitions:
   - Revenue = ${dc.revenue.definition}
   - Orders = ${dc.orders.definition}
   - Sessions = ${dc.sessions.definition}
   - Conversion rate = ${dc.conversion_rate.definition} (${dc.conversion_rate.warning})
   - ROAS = ${dc.roas.definition} (${dc.roas.warning})
3. CROSS-SOURCE VALIDATION — ${ar.discrepancy_flag.rule}
4. PATTERN DETECTION — Find the biggest signal in the data. What's working? What's broken?
5. ROOT CAUSE HYPOTHESIS — Why is that pattern happening? Name the specific driver.
6. ACTION PRESCRIPTION — One specific action per tile. Name the product, page, or campaign.

## Safety Rails
- ${rails.minimum_purchases.rule}
- ${rails.minimum_trend_days.rule}
- ${rails.session_drop_flag.rule}
- ${rails.revenue_gap_flag.rule}

## Output Format
- Write like a sharp advisor texting a store owner. No corporate buzzwords.
- Use £ for all currency values.
- Use emoji STRATEGICALLY only: 📈📉 trends, 💰 money, ⚠️ problems, ✅ wins, 🎯 actions
- Every sentence must be actionable or data-driven. No filler.
- NEVER just celebrate wins. Every positive MUST include "but here's how to go further".
- Format positives as: [Current state] → [Action] = [Expected result]
- Use SPECIFIC product names from the data. Never say "your products" — name them.
- If revenue is estimated, note with ~ prefix.
- Do NOT present cross-source conversion rate as exact — it's directional only.`;
}

// --- Data Summary Builder ---

function buildDataSummary(shopifyStats, gaData, metaAdsData, topProducts) {
  const summary = {
    period: "Last 30 days",
    shopify: {
      orders: shopifyStats.orderCount,
      revenue: shopifyStats.revenue,
      revenue_is_estimated: shopifyStats.revenueIsEstimated,
      aov: shopifyStats.avgOrderValue,
      sample_size: shopifyStats.sampleSize,
    },
    ga4: null,
    meta_ads: null,
    top_products: null,
  };

  if (gaData) {
    summary.ga4 = {
      sessions: gaData.sessions,
      bounce_rate: gaData.bounceRate,
      users: gaData.users,
      page_views: gaData.pageViews,
    };
  }

  if (metaAdsData) {
    summary.meta_ads = {
      spend: metaAdsData.spend,
      impressions: metaAdsData.impressions,
      clicks: metaAdsData.clicks,
      purchases: metaAdsData.purchases,
      revenue: metaAdsData.revenue,
      roas: metaAdsData.spend > 0 ? parseFloat((metaAdsData.revenue / metaAdsData.spend).toFixed(2)) : null,
      cpc: metaAdsData.clicks > 0 ? parseFloat((metaAdsData.spend / metaAdsData.clicks).toFixed(2)) : null,
      ctr: metaAdsData.impressions > 0 ? parseFloat(((metaAdsData.clicks / metaAdsData.impressions) * 100).toFixed(2)) : null,
    };
  }

  if (topProducts) {
    summary.top_products = {
      by_revenue: topProducts.byRevenue.map(p => ({
        title: p.title,
        revenue: parseFloat(p.revenue.toFixed(2)),
        units: p.units,
      })),
      by_units: topProducts.byUnits.map(p => ({
        title: p.title,
        revenue: parseFloat(p.revenue.toFixed(2)),
        units: p.units,
      })),
    };
  }

  return summary;
}

// --- Tile Prompts ---

const TILE_PROMPTS = {
  HEALTH_CHECK: `### HEALTH CHECK
Start with EXACTLY one status emoji: 🟢 (healthy), 🟡 (needs attention), or 🔴 (critical).
One-line verdict. Then 3 key metrics on new lines: Revenue, Orders, AOV — each with brief context.
Every metric must include an improvement action. 40 words max total.`,

  BIGGEST_ISSUE: `### BIGGEST ISSUE
The #1 thing costing money right now. Name the specific problem, the £ impact, and one fix. Be blunt. 30 words max.`,

  QUICK_WIN: `### QUICK WIN
One specific action for THIS WEEK. Name the product/page/campaign. What to do and expected £ impact. 30 words max.`,

  OPPORTUNITY: `### OPPORTUNITY
One growth pattern from the data. Name specific products. Recommendation with realistic £ potential over 30 days. 30 words max.`,

  AD_PERFORMANCE: `### AD PERFORMANCE
Start with EXACTLY one status emoji: 🟢 (ROAS >2.5), 🟡 (ROAS 1.5-2.5), or 🔴 (ROAS <1.5).
ROAS value, verdict, and one specific optimization. Name what to change. 30 words max.`,
};

// --- Full Tile Prompt Builder ---

function buildTilePrompt(dataSummary, hasMetaAds) {
  let dataBlock = `Here is the store data for the ${dataSummary.period}:\n\n`;

  // Shopify
  const s = dataSummary.shopify;
  dataBlock += `SHOPIFY DATA:\n`;
  dataBlock += `- Orders: ${s.orders.toLocaleString()} (exact count)\n`;
  dataBlock += `- AOV: £${s.aov.toFixed(2)} (from ${s.sample_size} order sample)\n`;
  if (s.revenue_is_estimated) {
    dataBlock += `- Estimated revenue: ~£${s.revenue.toFixed(2)} (AOV × order count)\n`;
  } else {
    dataBlock += `- Revenue: £${s.revenue.toFixed(2)}\n`;
  }

  // GA4
  if (dataSummary.ga4) {
    const g = dataSummary.ga4;
    dataBlock += `\nGA4 DATA:\n`;
    dataBlock += `- Sessions: ${g.sessions.toLocaleString()}\n`;
    dataBlock += `- Bounce rate: ${(g.bounce_rate * 100).toFixed(1)}%\n`;
    dataBlock += `- Users: ${g.users.toLocaleString()}\n`;
    dataBlock += `- Page views: ${g.page_views.toLocaleString()}\n`;
  } else {
    dataBlock += `\nGA4 DATA: Not connected\n`;
  }

  // Meta Ads
  if (dataSummary.meta_ads) {
    const m = dataSummary.meta_ads;
    dataBlock += `\nMETA ADS DATA:\n`;
    dataBlock += `- Spend: £${m.spend.toFixed(2)}\n`;
    dataBlock += `- Impressions: ${m.impressions.toLocaleString()}\n`;
    dataBlock += `- Clicks: ${m.clicks.toLocaleString()}\n`;
    dataBlock += `- CPC: £${m.cpc !== null ? m.cpc.toFixed(2) : "N/A"}\n`;
    dataBlock += `- CTR: ${m.ctr !== null ? m.ctr.toFixed(2) + "%" : "N/A"}\n`;
    dataBlock += `- Purchases: ${m.purchases}\n`;
    dataBlock += `- Revenue (Shopify-attributed): £${m.revenue.toFixed(2)}\n`;
    dataBlock += `- ROAS (Shopify revenue ÷ Meta spend): ${m.roas !== null ? m.roas + "x" : "N/A"}\n`;
  } else {
    dataBlock += `\nMETA ADS DATA: Not connected\n`;
  }

  // Top Products
  if (dataSummary.top_products) {
    const tp = dataSummary.top_products;
    if (tp.by_revenue.length > 0) {
      dataBlock += `\nTOP PRODUCTS BY REVENUE:\n`;
      tp.by_revenue.forEach((p, i) => {
        dataBlock += `${i + 1}. ${p.title} — £${p.revenue.toFixed(2)} (${p.units} units)\n`;
      });
    }
    if (tp.by_units.length > 0) {
      dataBlock += `\nTOP PRODUCTS BY UNITS SOLD:\n`;
      tp.by_units.forEach((p, i) => {
        dataBlock += `${i + 1}. ${p.title} — ${p.units} units (£${p.revenue.toFixed(2)})\n`;
      });
    }
  }

  // Tile instructions
  const tileCount = hasMetaAds ? 5 : 4;
  let tileBlock = `\nRespond with EXACTLY these ${tileCount} sections using ### headers:\n\n`;
  tileBlock += TILE_PROMPTS.HEALTH_CHECK + "\n\n";
  tileBlock += TILE_PROMPTS.BIGGEST_ISSUE + "\n\n";
  tileBlock += TILE_PROMPTS.QUICK_WIN + "\n\n";
  tileBlock += TILE_PROMPTS.OPPORTUNITY;
  if (hasMetaAds) {
    tileBlock += "\n\n" + TILE_PROMPTS.AD_PERFORMANCE;
  }

  return dataBlock + tileBlock;
}

// --- Context Validation ---

function validateBusinessContext(businessContext, dataSummary) {
  const notes = [];
  const bp = businessContext.business_profile;
  const targets = businessContext.targets_and_constraints;
  const s = dataSummary.shopify;

  // 1. AOV band check
  const aovBandMatch = bp.aov_band.match(/\u00a3(\d+)-(\d+)/);
  if (aovBandMatch) {
    const bandLow = parseFloat(aovBandMatch[1]);
    const bandHigh = parseFloat(aovBandMatch[2]);
    if (s.aov < bandLow) {
      notes.push(`Your actual AOV this period was \u00a3${s.aov.toFixed(2)}, which is below your stated ${bp.aov_band} band. You might want to update business-context.json.`);
    } else if (s.aov > bandHigh) {
      notes.push(`Your actual AOV this period was \u00a3${s.aov.toFixed(2)}, which is above your stated ${bp.aov_band} band. You might want to update business-context.json.`);
    }
  }

  // 2. Hero products check — are they in the top 5 by revenue?
  if (bp.hero_products.length > 0 && dataSummary.top_products && dataSummary.top_products.by_revenue.length > 0) {
    const topTitles = dataSummary.top_products.by_revenue.slice(0, 5).map(p => p.title.toLowerCase());
    const missingHeroes = bp.hero_products.filter(hero => !topTitles.includes(hero.toLowerCase()));
    if (missingHeroes.length > 0) {
      notes.push(`Hero product${missingHeroes.length > 1 ? "s" : ""} not in top 5 by revenue this period: ${missingHeroes.join(", ")}. Either they're underperforming or the hero list in business-context.json needs updating.`);
    }
  }

  // 3. ROAS vs goal check
  if (targets.roas_goal && dataSummary.meta_ads && dataSummary.meta_ads.roas !== null) {
    const actualRoas = dataSummary.meta_ads.roas;
    const goalFloor = targets.roas_goal * 0.5;
    if (actualRoas < goalFloor) {
      notes.push(`Blended ROAS is ${actualRoas}x \u2014 below 50% of your ${targets.roas_goal}x goal for the full 30-day period. Consider whether the ${targets.roas_goal}x target is realistic or if ad strategy needs reworking.`);
    }
  }

  // 4. CPA vs CAC ceiling check
  if (targets.cac_ceiling && dataSummary.meta_ads && dataSummary.meta_ads.spend > 0 && s.orders > 0) {
    const actualCpa = dataSummary.meta_ads.spend / s.orders;
    if (actualCpa > targets.cac_ceiling) {
      const overBy = ((actualCpa / targets.cac_ceiling - 1) * 100).toFixed(0);
      if (actualCpa > targets.cac_ceiling * 2) {
        notes.push(`CPA is \u00a3${actualCpa.toFixed(2)} \u2014 more than double your \u00a3${targets.cac_ceiling} ceiling. This has been consistently above target. The ceiling may be set too low for this channel, or ad efficiency needs serious attention.`);
      } else {
        notes.push(`CPA is \u00a3${actualCpa.toFixed(2)}, which is ${overBy}% above your \u00a3${targets.cac_ceiling} CAC ceiling. Worth investigating whether this is a recent spike or a consistent pattern.`);
      }
    }
  }

  return notes;
}

module.exports = {
  buildSystemPrompt,
  buildDataSummary,
  buildTilePrompt,
  validateBusinessContext,
  TILE_PROMPTS,
};
