// routes/odds.js
// Telepítés: npm install node-fetch (ha Node 18 alatt vagy, különben beépített fetch)
// .env fájlba: ODDS_API_KEY=your_key_here

const express = require('express');
const router  = express.Router();

const BASE = 'https://api.the-odds-api.com/v4';
const KEY  = process.env.ODDS_API_KEY;

// CORS – külső forrásból (pl. claude.ai) is elérhető legyen
router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
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
    const url = `${BASE}/sports/${sport}/odds/?apiKey=${KEY}&regions=eu&markets=h2h&dateFormat=iso`;
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
// ─────────────────────────────────────────────
