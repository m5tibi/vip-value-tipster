const express = require("express");
const fs      = require("fs");
const path    = require("path");
const auth    = require("../auth");
const usersDb = require("../users");
const { rateLimit }    = require("../lib/security");
const { requireAdmin } = require("../lib/admin");

const router = express.Router();
const dataDir = () => process.env.DATA_DIR || "/data";

// ── Analyzer history szinkronizáció ──────────────────────
// Az elemző előfizetői funkció: az előzmény a belépett felhasználó fiókjához kötődik
// (ah_u_<userId>.json), így több eszközről is ugyanaz látszik.
const userPath = userId => path.join(dataDir(), "ah_u_" + String(userId).replace(/[^a-zA-Z0-9-]/g, "") + ".json");

// Régebben az előzmény az API-kulcs SHA-256 hash-éhez (uid) kötődött. Ha a fióknak még nincs
// fájlja, de a kliens által küldött uid-hoz van, azt átnevezzük a fiókéra (egyszeri átállás).
// Az uid-ot csak az ismerheti, akinél a kulcs van, így más előzményét nem lehet átvenni.
function historyPath(req, uid) {
  const p = userPath(req.user.id);
  if (!fs.existsSync(p) && /^[a-f0-9]{64}$/.test(String(uid || ""))) {
    const legacy = path.join(dataDir(), "ah_" + uid + ".json");
    try { if (fs.existsSync(legacy)) fs.renameSync(legacy, p); } catch (e) {}
  }
  return p;
}

router.get("/api/analyzer-history", auth.requireAccess, (req, res) => {
  try {
    const p = historyPath(req, req.query.uid);
    if (!fs.existsSync(p)) return res.json([]);
    res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch (e) { res.json([]); }
});

const analyzerLimiter = rateLimit("analyzer", 60, 60 * 60 * 1000);   // lemez teleírása ellen
router.post("/api/analyzer-history", auth.requireAccess, analyzerLimiter, (req, res) => {
  const { uid, entry, entries } = req.body || {};
  if (!entry && !Array.isArray(entries)) return res.status(400).json({ error: 'Hiányzó adat' });
  try {
    const p = historyPath(req, uid);
    const hist = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
    // entries: a böngészőben tárolt teljes előzmény egyszeri feltöltése (ha a szerveren még nincs)
    const newHist = (entry ? [entry, ...hist] : [...entries, ...hist]).slice(0, 50);
    fs.writeFileSync(p, JSON.stringify(newHist), 'utf8');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/api/analyzer-history", auth.requireAccess, (req, res) => {
  try {
    const p = userPath(req.user.id);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: ki használta az elemzőt? Fiókhoz kötött (ah_u_<userId>) és régi, API-kulcshoz kötött
// (ah_<hash>) előzményfájlok. Az elemzések a böngészőből közvetlenül a Claude-hoz mennek, így
// csak azok látszanak, akiknél legalább egy elemzés mentésre került.
router.get("/api/admin/analyzer-usage", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const dir = dataDir();
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^ah_[a-zA-Z0-9_-]+\.json$/.test(f)); } catch (e) {}
  const users = files.map(f => {
    const full = path.join(dir, f);
    let entries = [];
    try { entries = JSON.parse(fs.readFileSync(full, "utf8")); } catch (e) {}
    if (!Array.isArray(entries)) entries = [];
    const id = f.slice(3, -5);
    const userId = id.startsWith("u_") ? id.slice(2) : null;
    const u = userId ? usersDb.findById(userId) : null;
    return {
      uid:       id,
      userId,
      email:     u?.email || null,
      isAdmin:   !!u?.isAdmin,
      legacy:    !userId,                             // régi, API-kulcshoz kötött előzmény
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
