// routes/odds.js
// Telepítés: npm install node-fetch (ha Node 18 alatt vagy, különben beépített fetch)
// .env fájlba: ODDS_API_KEY=your_key_here

const express = require('express');
const fetch   = require('node-fetch');
const router  = express.Router();

const BASE  = 'https://api.the-odds-api.com/v4';
const KEY   = process.env.ODDS_API_KEY;
const TOKEN = process.env.ODDS_PROXY_TOKEN; // opcionális: ha be van állítva, kötelező a hívásokhoz

// CORS – külső forrásból (pl. claude.ai) is elérhető legyen
router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-proxy-token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Token-ellenőrzés – csak akkor lép életbe, ha ODDS_PROXY_TOKEN be van állítva.
// Így megvédi a fizetős ODDS_API_KEY kvótát attól, hogy bárki használja a proxyt.
// A tokent add meg ?token=... query paraméterként vagy x-proxy-token headerben.
router.use((req, res, next) => {
  if (!TOKEN) return next();
  const t = req.get('x-proxy-token') || req.query.token;
  if (t !== TOKEN) return res.status(403).json({ error: 'Hozzáférés megtagadva — hibás vagy hiányzó proxy token.' });
  next();
});

// GET /api/odds/sports
// Visszaadja az összes aktív, nem outrights sportot
router.get('/sports', async (req, res) => {
  if (!KEY) return res.status(500).json({ error: 'ODDS_API_KEY nincs beállítva a szerveren' });
  try {
    const r = await fetch(`${BASE}/sports/?apiKey=${KEY}`);
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: 'Odds API hiba', detail: d });
    res.json(d.filter(s => s.active && !s.has_outrights));
  } catch (e) {
    res.status(500).json({ error: 'Szerver hiba', detail: e.message });
  }
});

// GET /api/odds/matches?sport=soccer_epl
// Visszaadja a meccseket Pinnacle + Bet365 + Unibet oddszokkal
router.get('/matches', async (req, res) => {
  if (!KEY) return res.status(500).json({ error: 'ODDS_API_KEY nincs beállítva a szerveren' });
  const { sport } = req.query;
  if (!sport) return res.status(400).json({ error: 'Hiányzó sport paraméter' });
  try {
    const url = `${BASE}/sports/${sport}/odds/?apiKey=${KEY}&regions=eu&markets=h2h,totals,spreads&dateFormat=iso`;
    const r = await fetch(url);
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: 'Odds API hiba', detail: d });
    res.json(d);
  } catch (e) {
    res.status(500).json({ error: 'Szerver hiba', detail: e.message });
  }
});

module.exports = router;

// ─────────────────────────────────────────────
// app.js / server.js -be add hozzá:
//
// const oddsRouter = require('./routes/odds');
// app.use('/api/odds', oddsRouter);
//
// .env fájlba:
// ODDS_API_KEY=your_odds_api_key_here
//
// Render → Environment Variables-be is fel kell venni:
// ODDS_API_KEY = your_odds_api_key_here
//
// Opcionális, de AJÁNLOTT (publikus URL esetén) a proxy védelme:
// ODDS_PROXY_TOKEN = valami_hosszu_veletlen_string
// Ekkor a hívásokhoz kell: /api/odds/matches?sport=...&token=valami_hosszu_veletlen_string
// vagy x-proxy-token header. Ha nincs beállítva, a proxy nyitva marad (visszafelé kompatibilis).
// ─────────────────────────────────────────────
