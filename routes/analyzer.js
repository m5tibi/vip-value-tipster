const express = require("express");
const fs      = require("fs");
const path    = require("path");
const { rateLimit }    = require("../lib/security");
const { requireAdmin } = require("../lib/admin");

const router = express.Router();

// ── Analyzer history szinkronizáció ──────────────────────
// Az uid a felhasználó saját Claude API kulcsának SHA-256 hash-e (64 hex karakter) –
// kitalálhatatlan, így más előzményét nem lehet olvasni/törölni. Rövidebb (régi) uid-t elutasítunk.
function aPath(uid) {
  if (!/^[a-f0-9]{64}$/.test(String(uid))) return null;
  return path.join(process.env.DATA_DIR || "/data", "ah_" + uid + ".json");
}

router.get("/api/analyzer-history", (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.json([]);
  try {
    const p = aPath(uid);
    if (!p || !fs.existsSync(p)) return res.json([]);
    res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch (e) { res.json([]); }
});

const analyzerLimiter = rateLimit("analyzer", 60, 60 * 60 * 1000);   // lemez teleírása ellen
router.post("/api/analyzer-history", analyzerLimiter, (req, res) => {
  const { uid, entry, entries } = req.body || {};
  const p = aPath(uid);
  if (!p || (!entry && !Array.isArray(entries))) return res.status(400).json({ error: 'Hiányzó vagy érvénytelen adat' });
  try {
    const hist = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
    // entries: a böngészőben tárolt teljes előzmény egyszeri feltöltése (átállás az új uid-ra)
    const newHist = (entry ? [entry, ...hist] : [...entries, ...hist]).slice(0, 50);
    fs.writeFileSync(p, JSON.stringify(newHist), 'utf8');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/api/analyzer-history", (req, res) => {
  const uid = req.query.uid;
  const p = aPath(uid);
  if (!p) return res.status(400).json({ error: 'Hiányzó vagy érvénytelen uid' });
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: ki használta az elemzőt? Minden ah_*.json fájl egy felhasználó (egy API-kulcs) mentett
// előzménye. Az elemzések a böngészőből közvetlenül a Claude-hoz mennek, így csak azok
// látszanak, akiknél legalább egy elemzés mentésre került.
router.get("/api/admin/analyzer-usage", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const dir = process.env.DATA_DIR || "/data";
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^ah_[a-z0-9]+\.json$/.test(f)); } catch (e) {}
  const users = files.map(f => {
    const full = path.join(dir, f);
    let entries = [];
    try { entries = JSON.parse(fs.readFileSync(full, "utf8")); } catch (e) {}
    if (!Array.isArray(entries)) entries = [];
    const uid = f.slice(3, -5);
    return {
      uid,
      legacy:    !/^[a-f0-9]{64}$/.test(uid),        // régi (javítás előtti) azonosító
      count:     entries.length,                      // max. 50-et tárolunk felhasználónként
      lastUsed:  entries[0]?.ts || null,
      firstSeen: entries[entries.length - 1]?.ts || null,
      updatedAt: fs.statSync(full).mtime.toISOString(),
      recentQueries: entries.slice(0, 5).map(e => String(e.query || "").slice(0, 120)),
    };
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json({
    users,
    totalUsers:    users.length,
    totalAnalyses: users.reduce((a, u) => a + u.count, 0),
  });
});

module.exports = router;
