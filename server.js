const express = require("express");
const fetch   = require("node-fetch");
const path    = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID   = process.env.TG_CHAT_ID;
const EOD_HOUR     = 23;

const SPORT_MAP = {
  "soccer_uefa_champs_league":  { sport: "soccer",     label: "⚽ BL" },
  "soccer_epl":                 { sport: "soccer",     label: "⚽ Premier League" },
  "soccer_germany_bundesliga":  { sport: "soccer",     label: "⚽ Bundesliga" },
  "soccer_spain_la_liga":       { sport: "soccer",     label: "⚽ La Liga" },
  "soccer_italy_serie_a":       { sport: "soccer",     label: "⚽ Serie A" },
  "soccer_france_ligue_one":    { sport: "soccer",     label: "⚽ Ligue 1" },
  "basketball_nba":             { sport: "basketball", label: "🏀 NBA" },
  "basketball_euroleague":      { sport: "basketball", label: "🏀 Euroleague" },
  "icehockey_nhl":              { sport: "hockey",     label: "🏒 NHL" },
};

const EXCLUDED_BM = ["betfair_ex_eu", "betfair_ex_uk", "matchbook"];

// ── In-memory store ───────────────────────────────────────
let latestTips = [];
let history    = [];

// ── Telegram ──────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML" })
    });
  } catch (e) { console.error("Telegram hiba:", e.message); }
}

// ── Odds API + Value számítás ─────────────────────────────
async function fetchAndProcess() {
  const allTips = [];
  const now     = new Date();

  for (const [sportKey, meta] of Object.entries(SPORT_MAP)) {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal&dateFormat=iso`;
      const r = await fetch(url);
      if (!r.ok) { console.log(`${sportKey}: HTTP ${r.status}`); continue; }
      const games = await r.json();
      console.log(`${sportKey}: ${games.length} meccs`);

      for (const game of games) {
        const start = new Date(game.commence_time);

        // Csak a következő 24 óra meccsei
        const hoursUntilStart = (start - now) / 3600000;
        if (hoursUntilStart < 0 || hoursUntilStart > 24) continue;

        const validBMs = (game.bookmakers || []).filter(bm =>
          !EXCLUDED_BM.includes(bm.key) &&
          bm.markets?.[0]?.outcomes?.every(o => o.price > 1.05 && o.price < 50)
        );
        if (validBMs.length < 2) continue;

        const pinnacle    = validBMs.find(bm => bm.key === "pinnacle");
        const sharpBM     = pinnacle || validBMs[0];
        const sharpOutcomes = sharpBM.markets[0].outcomes;
        const overround   = sharpOutcomes.reduce((s, o) => s + 1 / o.price, 0);

        for (const sharpO of sharpOutcomes) {
          let bestOdds = 0, bestBM = "";
          for (const bm of validBMs) {
            const o = bm.markets[0]?.outcomes?.find(x => x.name === sharpO.name);
            if (o && o.price > bestOdds) { bestOdds = o.price; bestBM = bm.title; }
          }
          if (!bestOdds) continue;

          const odds     = parseFloat(bestOdds.toFixed(2));
          if (odds < 1.3 || odds > 6.0) continue;

          const trueProb = (1 / sharpO.price) / overround;
          const fairOdds = parseFloat((1 / trueProb).toFixed(2));
          const value    = parseFloat(((odds / fairOdds - 1) * 100).toFixed(1));
          if (value < 2) continue;

          allTips.push({
            id: `${game.id}-${sharpO.name}`,
            sport: meta.sport, sportLabel: meta.label,
            match: `${game.home_team} vs ${game.away_team}`,
            market: "1X2", pick: sharpO.name,
            odds, fairOdds,
            prob: Math.round(trueProb * 100), value,
            live, minute: null,
            confidence: value >= 12 ? 2 : value >= 6 ? 1 : 0,
            note: `Legjobb odds: ${bestBM} | Fair odds (${sharpBM.title} alapján): ${fairOdds}`,
            addedAt: new Date().toLocaleString("hu-HU"),
            result: "pending"
          });
        }
      }
    } catch (e) {
      console.error(`Hiba (${sportKey}):`, e.message);
    }
  }

  latestTips = allTips.sort((a, b) => b.value - a.value).slice(0, 10);

  const existingIds = new Set(history.map(t => t.id));
  const fresh = latestTips.filter(t => !existingIds.has(t.id));
  history = [...fresh, ...history];

  if (latestTips.length) {
    let msg = `🏆 <b>VIP Value Tipster – ${new Date().toLocaleString("hu-HU")}</b>\n\n`;
    latestTips.forEach(t => {
      msg += `${t.sportLabel} <b>${t.match}</b>\n`;
      msg += `📌 ${t.market} → <b>${t.pick}</b>\n`;
      msg += `📊 Odds: ${t.odds} | Fair: ${t.fairOdds} | Value: <b>+${t.value.toFixed(1)}%</b>\n`;
      msg += t.live ? "🔴 ÉLŐ" : "🔵 Pre-match";
      msg += "\n\n";
    });
    await sendTelegram(msg);
  }

  console.log(`[${new Date().toLocaleTimeString("hu-HU")}] Frissítve – ${latestTips.length} value tipp`);
}

// ── Okos ütemező (hétvége 3x, hétköznap 1x) ──────────────
function scheduleNextFetch() {
  const now     = new Date();
  const day     = now.getDay();
  const isWeekend = day === 0 || day === 5 || day === 6;
  const fetchHours = isWeekend ? [10, 15, 19] : [15];
  const currentH   = now.getHours();

  let nextH = fetchHours.find(h => h > currentH);
  let nextFetch;

  if (nextH !== undefined) {
    nextFetch = new Date(now);
    nextFetch.setHours(nextH, 0, 0, 0);
  } else {
    nextFetch = new Date(now);
    nextFetch.setDate(nextFetch.getDate() + 1);
    const tDay = nextFetch.getDay();
    const isWE = tDay === 0 || tDay === 5 || tDay === 6;
    nextFetch.setHours(isWE ? 10 : 15, 0, 0, 0);
  }

  const mins = Math.round((nextFetch - now) / 60000);
  console.log(`Következő lekérés: ${mins} perc múlva (${nextFetch.toLocaleTimeString("hu-HU")})`);
  setTimeout(() => { fetchAndProcess(); scheduleNextFetch(); }, nextFetch - now);
}

// ── Napi 23:00 statisztika ────────────────────────────────
setInterval(() => {
  const h = new Date().getHours(), m = new Date().getMinutes();
  if (h === EOD_HOUR && m === 0) {
    const won  = history.filter(t => t.result === "won").length;
    const lost = history.filter(t => t.result === "lost").length;
    const avg  = history.length ? (history.reduce((s,t) => s+t.value,0)/history.length).toFixed(1) : 0;
    sendTelegram(`📈 <b>Napi stat – ${new Date().toLocaleDateString("hu-HU")}</b>\n\nÖsszes: ${history.length}\n✅ Nyert: ${won}\n❌ Vesztett: ${lost}\n📊 Átl. value: +${avg}%`);
  }
}, 60000);

// ── API végpontok ─────────────────────────────────────────
app.get("/api/tips",    (req, res) => res.json(latestTips));
app.get("/api/history", (req, res) => res.json(history));

app.get("/api/status", (req, res) => {
  const now = new Date();
  const day = now.getDay();
  const isWeekend = day === 0 || day === 5 || day === 6;
  const fetchHours = isWeekend ? [10, 15, 19] : [15];
  const currentH   = now.getHours();
  let nextH = fetchHours.find(h => h > currentH);
  let nextFetch;
  if (nextH !== undefined) {
    nextFetch = new Date(now); nextFetch.setHours(nextH, 0, 0, 0);
  } else {
    nextFetch = new Date(now); nextFetch.setDate(nextFetch.getDate() + 1);
    const tDay = nextFetch.getDay();
    nextFetch.setHours((tDay === 0 || tDay === 5 || tDay === 6) ? 10 : 15, 0, 0, 0);
  }
  res.json({ tipsCount: latestTips.length, lastUpdate: latestTips[0]?.addedAt || null, nextFetchMs: nextFetch - now, isWeekend, fetchHours });
});

app.post("/api/refresh", async (req, res) => {
  await fetchAndProcess();
  res.json({ ok: true, count: latestTips.length });
});

app.patch("/api/history/:id", (req, res) => {
  const { result } = req.body;
  history    = history.map(t => t.id === req.params.id ? { ...t, result } : t);
  latestTips = latestTips.map(t => t.id === req.params.id ? { ...t, result } : t);
  res.json({ ok: true });
});

app.post("/api/stats/send", async (req, res) => {
  const won  = history.filter(t => t.result === "won").length;
  const lost = history.filter(t => t.result === "lost").length;
  const avg  = history.length ? (history.reduce((s,t) => s+t.value,0)/history.length).toFixed(1) : 0;
  await sendTelegram(`📈 <b>Napi stat – ${new Date().toLocaleDateString("hu-HU")}</b>\n\nÖsszes: ${history.length}\n✅ Nyert: ${won}\n❌ Vesztett: ${lost}\n📊 Átl. value: +${avg}%`);
  res.json({ ok: true });
});

// ── Indítás ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VIP Tipster fut: http://localhost:${PORT}`));

fetchAndProcess();
scheduleNextFetch();
