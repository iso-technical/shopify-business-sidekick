const config = require("./config");
const logger = require("./logger");
const { buildSystemPrompt, buildDataSummary, buildTilePrompt, validateBusinessContext } = require("../prompts");
const businessContext = require("../business-context.json");

async function generateTileInsights(shopifyStats, gaData, metaAdsData, topProducts) {
  if (!config.ANTHROPIC_API_KEY) {
    logger.info("[insights] ANTHROPIC_API_KEY not set");
    return null;
  }

  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const dataSummary = buildDataSummary(shopifyStats, gaData, metaAdsData, topProducts);
  const hasMetaAds = !!metaAdsData;
  const systemPrompt = buildSystemPrompt(businessContext);
  let userPrompt = buildTilePrompt(dataSummary, hasMetaAds);

  const contextNotes = validateBusinessContext(businessContext, dataSummary);
  if (contextNotes.length > 0) {
    logger.info("[insights] context validation notes:", contextNotes);
    const contextBlock = "\nCONTEXT NOTES (acknowledge these briefly at the start of HEALTH CHECK):\n" +
      contextNotes.map(n => `- ${n}`).join("\n") + "\n";
    userPrompt = contextBlock + "\n" + userPrompt;
  }

  logger.info("[insights] sending tile prompt to Claude (system + user prompt)...");

  const message = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: hasMetaAds ? 1000 : 800,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = message.content[0]?.text || "";
  logger.info("[insights] received tile response, length:", text.length);

  const tiles = { healthCheck: "", biggestIssue: "", quickWin: "", opportunity: "", adPerformance: "" };
  const sections = text.split(/###\s*/);
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    const firstLine = trimmed.split("\n")[0].toUpperCase();
    const body = trimmed.replace(/^[^\n]+\n/, "").trim();
    if (firstLine.includes("HEALTH")) tiles.healthCheck = body;
    else if (firstLine.includes("ISSUE")) tiles.biggestIssue = body;
    else if (firstLine.includes("QUICK") || firstLine.includes("WIN")) tiles.quickWin = body;
    else if (firstLine.includes("OPPORTUN")) tiles.opportunity = body;
    else if (firstLine.includes("AD") && firstLine.includes("PERF")) tiles.adPerformance = body;
  }

  let healthSeverity = "healthy";
  if (tiles.healthCheck.includes("\ud83d\udfe1")) healthSeverity = "warning";
  else if (tiles.healthCheck.includes("\ud83d\udd34")) healthSeverity = "critical";

  let adSeverity = "healthy";
  if (metaAdsData && metaAdsData.spend > 0) {
    const roas = metaAdsData.revenue / metaAdsData.spend;
    if (roas < 1.5) adSeverity = "critical";
    else if (roas <= 2.5) adSeverity = "warning";
  }

  tiles.healthSeverity = healthSeverity;
  tiles.adSeverity = adSeverity;

  logger.info("[insights] parsed tiles:", Object.keys(tiles).map(k => `${k}: ${typeof tiles[k] === "string" ? tiles[k].length + " chars" : tiles[k]}`));
  return tiles;
}

module.exports = { generateTileInsights };
