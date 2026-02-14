const express = require("express");
const router = express.Router();
const { getShopToken, deleteShopToken } = require("../lib/cache");
const { buildSettingsHtml } = require("../views/settings");

router.get("/settings", (req, res) => {
  const shop = req.query.shop;
  const tokenData = shop ? getShopToken(shop) : null;

  if (!shop || !tokenData) {
    if (shop) {
      return res.redirect(`/install?shop=${encodeURIComponent(shop)}`);
    }
    return res.redirect("/install");
  }

  res.send(buildSettingsHtml(shop));
});

// POST to prevent CSRF on this destructive action
router.post("/disconnect", (req, res) => {
  const shop = req.query.shop || req.body?.shop;
  if (shop) {
    deleteShopToken(shop);
  }
  req.session.destroy(() => {
    res.redirect("/install");
  });
});

module.exports = router;
