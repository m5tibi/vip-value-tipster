const express = require("express");
const fs      = require("fs");
const path    = require("path");

// ── Meta Pixel ───────────────────────────────────────────
// /tracking.js: a süti-hozzájárulás + pixel kliens kódja (lib/tracking-client.js), elé téve a
// pixel azonosítóját a META_PIXEL_ID környezeti változóból. Ha nincs beállítva, a kód nem csinál
// semmit (nincs süti-sáv, nincs pixel).
const router = express.Router();
const client = fs.readFileSync(path.join(__dirname, "..", "lib", "tracking-client.js"), "utf8");

router.get("/tracking.js", (req, res) => {
  const pid   = String(process.env.META_PIXEL_ID || "").trim();
  const value = Number(process.env.META_PURCHASE_VALUE || 14990) || 0;   // Purchase esemény értéke (HUF)
  const cfg = `window.__META_PIXEL_ID=${JSON.stringify(/^\d{5,20}$/.test(pid) ? pid : "")};` +
              `window.__META_PURCHASE_VALUE=${JSON.stringify(value)};\n`;
  res.type("application/javascript").set("Cache-Control", "public, max-age=300").send(cfg + client);
});

module.exports = router;
