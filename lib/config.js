require("dotenv").config();
const crypto = require("crypto");

const config = {
  // Server
  PORT: process.env.PORT || 3000,
  HOST: process.env.HOST,
  NODE_ENV: process.env.NODE_ENV || "development",
  SESSION_SECRET: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),

  // Shopify
  SHOPIFY_API_KEY: process.env.SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET: process.env.SHOPIFY_API_SECRET,
  SCOPES: "read_products,read_orders",
  APP_HANDLE: process.env.APP_HANDLE || "shopify-dashboard",
  SHOPIFY_API_VERSION: "2024-01",

  // Google Analytics
  GA_PROPERTY_ID: process.env.GA_PROPERTY_ID,
  GA_SERVICE_ACCOUNT_JSON: process.env.GA_SERVICE_ACCOUNT_JSON,

  // Meta Ads
  META_SYSTEM_USER_TOKEN: process.env.META_SYSTEM_USER_TOKEN,
  META_AD_ACCOUNT_ID: process.env.META_AD_ACCOUNT_ID,
  META_API_VERSION: "v18.0",

  // Claude AI
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,

  // Derived
  isProduction: process.env.NODE_ENV === "production",
  isDevelopment: process.env.NODE_ENV !== "production",
};

if (!config.SHOPIFY_API_KEY || !config.SHOPIFY_API_SECRET) {
  console.error("Missing SHOPIFY_API_KEY or SHOPIFY_API_SECRET env vars");
  process.exit(1);
}

if (config.isProduction && config.APP_HANDLE === "shopify-dashboard") {
  console.warn("WARNING: APP_HANDLE is using the default value. Set it in your environment variables.");
}

module.exports = Object.freeze(config);
