const express = require("express");
const fetch   = require("node-fetch");
const path    = require("path");

const fs   = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const ODDS_API_KEY  = process.env.ODDS_API_KEY;
const TG_BOT_TOKEN  = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID    = process.env.TG_CHAT_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const EOD_HOUR      = 23;
const DATA_FILE     = path.join(__dirname, "data", "history.json");

// ── Perzisztens tárolás ───────────────────────────────────
function loadHistory() {
  try {
    if (!fs.existsSync(path.dirname(DATA_FILE))) fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    if (!fs.existsSync(DATA_FILE)) return [];
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) { console.error("History betöltési hiba:", e.message); return []; }
}

function saveHistory() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(history, null, 2), "utf8");
  } catch (e) { console.error("History mentési hiba:", e.message); }
}

const SPORT_MAP = {
  "soccer_fifa_world_cup":             { sport: "soccer",     label: "⚽ FIFA VB 2026",      minValue: 6 },
  "soccer_uefa_champs_league":         { sport: "soccer",     label: "⚽ BL",                 minValue: 6 },
  "soccer_epl":                        { sport: "soccer",     label: "⚽ Premier League",      minValue: 6 },
  "soccer_germany_bundesliga":         { sport: "soccer",     label: "⚽ Bundesliga",          minValue: 6 },
  "soccer_spain_la_liga":              { sport: "soccer",     label: "⚽ La Liga",             minValue: 6 },
  "soccer_italy_serie_a":              { sport: "soccer",     label: "⚽ Serie A",             minValue: 6 },
  "soccer_france_ligue_one":           { sport: "soccer",     label: "⚽ Ligue 1",             minValue: 6 },
  "soccer_conmebol_copa_libertadores": { sport: "soccer",     label: "⚽ Copa Libertadores",   minValue: 7 },
  "soccer_conmebol_copa_sudamericana": { sport: "soccer",     label: "⚽ Copa Sudamericana",   minValue: 7 },
  "basketball_nba":                    { sport: "basketball", label: "🏀 NBA",                 minValue: 6 },
  "basketball_wnba":                   { sport: "basketball", label: "🏀 WNBA",                minValue: 9 },
  "basketball_euroleague":             { sport: "basketball", label: "🏀 Euroleague",           minValue: 8 },
  "icehockey_nhl":                     { sport: "hockey",     label: "🏒 NHL",                 minValue: 6 },
  "icehockey_ahl":                     { sport: "hockey",     label: "🏒 AHL",                 minValue: 9 },
};

const EXCLUDED_BM = ["betfair_ex_eu", "betfair_ex_uk", "matchbook"];

let latestTips = [];
let aiTips     = [];
let history    = loadHistory();
console.log(`History betöltve: ${history.length} tipp`);

// ── Magyar idő ────────────────────────────────────────────
function getHungarianTime() {
  const hu = new Date().toLocaleString("en-US", { timeZone: "Europe/Budapest" });
  const d  = new Date(hu);
  return { hour: d.getHours(), minute: d.getMinutes(), day: d.getDay() };
}

// ── Telegram ──────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) { console.log("Telegram: hiányzó TOKEN vagy CHAT_ID"); return; }
  try {
    const r    = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML" })
    });
    const data = await r.json();
    if (!data.ok) console.error("Telegram hiba:", JSON.stringify(data));
    else console.log("Telegram: üzenet elküldve ✓");
  } catch (e) { console.error("Telegram fetch hiba:", e.message); }
}

// ── Value tippek (Pinnacle alapú) ─────────────────────────
async function fetchValueTips() {
  const allTips = [];
  const now     = new Date();

  for (const [sportKey, meta] of Object.entries(SPORT_MAP)) {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal&dateFormat=iso`;
      const r   = await fetch(url);
      if (!r.ok) { console.log(`${sportKey}: HTTP ${r.status}`); continue; }
      const games = await r.json();
      console.log(`${sportKey}: ${games.length} meccs`);

      for (const game of games) {
        const start         = new Date(game.commence_time);
        const hoursUntil    = (start - now) / 3600000;
        if (hoursUntil < 0 || hoursUntil > 24) continue;

        const alreadyTipped = new Set(history.filter(t => t.type === "value").map(t => t.matchId));
        if (alreadyTipped.has(game.id)) continue;

        const validBMs = (game.bookmakers || []).filter(bm =>
          !EXCLUDED_BM.includes(bm.key) &&
          bm.markets?.[0]?.outcomes?.every(o => o.price > 1.05 && o.price < 50)
        );
        if (validBMs.length < 2) continue;

        const pinnacle      = validBMs.find(bm => bm.key === "pinnacle");
        const sharpBM       = pinnacle || validBMs[0];
        const sharpOutcomes = sharpBM.markets[0].outcomes;
        if (sharpOutcomes.length < 2) continue;

        const overround = sharpOutcomes.reduce((s, o) => s + 1 / o.price, 0);
        if (overround < 1.0 || overround > 1.15) continue;

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
          if (value < meta.minValue) continue;

          // Kelly kritérium (töredék Kelly: 25%)
          const kellyFull = (trueProb * odds - 1) / (odds - 1);
          const kelly     = parseFloat((kellyFull * 0.25 * 100).toFixed(1));

          allTips.push({
            id: `${game.id}-${sharpO.name}-${Date.now()}`,
            matchId: game.id,
            type: "value",
            sport: meta.sport, sportLabel: meta.label,
            match: `${game.home_team} vs ${game.away_team}`,
            commence: new Date(game.commence_time).toLocaleString("hu-HU", { timeZone: "Europe/Budapest", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
            market: "1X2", pick: sharpO.name,
            odds, fairOdds,
            prob: Math.round(trueProb * 100), value,
            kelly,
            live: false,
            note: `Legjobb odds: ${bestBM} | Fair odds (${sharpBM.title}): ${fairOdds}`,
            addedAt: new Date().toLocaleString("hu-HU"),
            result: "pending"
          });
        }
      }
    } catch (e) { console.error(`Hiba (${sportKey}):`, e.message); }
  }
  return allTips.sort((a, b) => b.value - a.value).slice(0, 5);
}

// ── AI elemzett tippek (Claude) ───────────────────────────
async function fetchAiTips(matchList) {
  if (!ANTHROPIC_KEY || !matchList.length) return [];
  console.log(`AI elemzés: ${matchList.length} meccs`);

  const matchText = matchList.map(m =>
    `- ${m.sport} | ${m.match} | Kezdés: ${m.commence}\n  Valós odds: ${m.odds.map(o => `${o.name}: ${o.odds} (${o.bookmaker})`).join(", ")}`
  ).join("\n");

  const prompt = `Te egy profi sportfogadási elemző vagy. Használj web keresést hogy megtudd az aktuális formát, sérüléseket, és keretinformációkat az alábbi mai meccsekre, majd adj 2-3 konkrét fogadási tippet.

Mai meccsek:
${matchText}

Lépések:
1. Keress rá minden meccsre hogy megtudd az aktuális keretet, sérüléseket, formát
2. Az információk alapján adj megalapozott tippeket

Szabályok:
- Csak OVER típusú vagy pozitív kimenetelű tippek (over gólok, szögletek, lapszám, gólszerzők, hendikep győzelem)
- NE adj under típusú tippet
- Reális odds tartomány: 1.50 - 4.00
- Adj rövid (2-3 mondatos) magyar nyelvű indoklást VALÓS adatok alapján
- Csak olyan piacokat javasolj ami logikus az adott meccshez

Válaszolj KIZÁRÓLAG JSON tömbként, semmi más szöveg nélkül:
[
  {
    "match": "Csapat A vs Csapat B",
    "sport": "soccer",
    "sportLabel": "⚽ FIFA VB 2026",
    "commence": "06.20. 20:00",
    "market": "pl. Over 2.5 gól",
    "pick": "konkrét tipp neve",
    "odds": 1.85,
    "note": "Magyar indoklás 2-3 mondatban, valós adatokra hivatkozva."
  }
]`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await r.json();
    const text = data.content?.find(b => b.type === "text")?.text || "";
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) { console.log("AI: nem sikerült JSON-t kinyerni"); return []; }
    const parsed = JSON.parse(match[0]);
    return parsed.map(t => ({
      id: `ai-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      type: "ai",
      sport: t.sport,
      sportLabel: t.sportLabel,
      match: t.match,
      commence: t.commence || null,
      market: t.market,
      pick: t.pick,
      odds: t.odds,
      fairOdds: null,
      prob: null,
      value: null,
      kelly: null,
      live: false,
      note: t.note,
      addedAt: new Date().toLocaleString("hu-HU"),
      result: "pending"
    }));
  } catch (e) { console.error("AI tipp hiba:", e.message); return []; }
}

// ── Automatikus eredményjelölés ───────────────────────────
async function checkResults() {
  if (!history.filter(t => t.result === "pending").length) return;
  console.log("Eredmények ellenőrzése...");

  for (const sportKey of Object.keys(SPORT_MAP)) {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/scores/?apiKey=${ODDS_API_KEY}&daysFrom=2`;
      const r   = await fetch(url);
      if (!r.ok) continue;
      const games = await r.json();

      for (const game of games) {
        if (!game.completed || !game.scores) continue;

        // Megkeressük a pending tippeket ehhez a meccshez
        const pending = history.filter(t =>
          t.result === "pending" &&
          t.matchId === game.id
        );
        if (!pending.length) continue;

        const homeTeam = game.home_team;
        const awayTeam = game.away_team;
        const homeScore = parseInt(game.scores.find(s => s.name === homeTeam)?.score || 0);
        const awayScore = parseInt(game.scores.find(s => s.name === awayTeam)?.score || 0);

        for (const tip of pending) {
          let result = "lost";

          if (tip.market === "1X2") {
            if (tip.pick === homeTeam && homeScore > awayScore) result = "won";
            else if (tip.pick === awayTeam && awayScore > homeScore) result = "won";
            else if (tip.pick === "Draw" && homeScore === awayScore) result = "won";
          } else if (tip.market.includes("Over") && tip.market.includes("gól")) {
            const totalGoals = homeScore + awayScore;
            const line = parseFloat(tip.market.match(/[\d.]+/)?.[0] || 0);
            if (totalGoals > line) result = "won";
          } else if (tip.market.includes("BTTS") || tip.market.includes("Mindkét")) {
            if (homeScore > 0 && awayScore > 0) result = "won";
          } else if (tip.market.includes("hendikep") || tip.market.includes("Hendikep")) {
            const line = parseFloat(tip.pick.match(/-?[\d.]+/)?.[0] || 0);
            if (tip.pick.includes(homeTeam) && (homeScore + line) > awayScore) result = "won";
            else if (tip.pick.includes(awayTeam) && (awayScore + line) > homeScore) result = "won";
          }
          // Gólszerzős és egyéb AI tippek – manuális marad
          else { continue; }

          console.log(`  ${game.home_team} vs ${game.away_team}: ${tip.pick} → ${result} (${homeScore}-${awayScore})`);
          history    = history.map(t => t.id === tip.id ? { ...t, result } : t);
          latestTips = latestTips.map(t => t.id === tip.id ? { ...t, result } : t);
          aiTips     = aiTips.map(t => t.id === tip.id ? { ...t, result } : t);
          saveHistory();
        }
      }
    } catch (e) { console.error(`Scores hiba (${sportKey}):`, e.message); }
  }
}
async function fetchAndProcess() {
  const now = new Date();

  // 1. Value tippek
  const valueTips = await fetchValueTips();
  latestTips = valueTips;

  // 2. AI elemzéshez meccs lista összegyűjtése valós oddsokkal
  const matchList = [];
  for (const [sportKey, meta] of Object.entries(SPORT_MAP)) {
    try {
      const url   = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal&dateFormat=iso`;
      const r     = await fetch(url);
      if (!r.ok) continue;
      const games = await r.json();
      for (const game of games) {
        const start      = new Date(game.commence_time);
        const hoursUntil = (start - now) / 3600000;
        if (hoursUntil < 0 || hoursUntil > 24) continue;

        // Valós oddsok összegyűjtése bookmaker-enként
        const validBMs = (game.bookmakers || []).filter(bm =>
          !EXCLUDED_BM.includes(bm.key) &&
          bm.markets?.[0]?.outcomes?.every(o => o.price > 1.05 && o.price < 50)
        );
        if (validBMs.length < 2) continue;

        // Legjobb elérhető odds minden kimenetelre
        const outcomes = validBMs[0].markets[0].outcomes.map(o => o.name);
        const bestOdds = outcomes.map(name => {
          let best = 0, bestBM = "";
          for (const bm of validBMs) {
            const o = bm.markets[0]?.outcomes?.find(x => x.name === name);
            if (o && o.price > best) { best = o.price; bestBM = bm.title; }
          }
          return { name, odds: parseFloat(best.toFixed(2)), bookmaker: bestBM };
        });

        matchList.push({
          sport: meta.label,
          match: `${game.home_team} vs ${game.away_team}`,
          commence: new Date(game.commence_time).toLocaleString("hu-HU", { timeZone: "Europe/Budapest", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
          odds: bestOdds
        });
      }
    } catch {}
  }

  // 3. AI tippek
  const newAiTips = await fetchAiTips(matchList);
  aiTips = newAiTips;

  const existingIds = new Set(history.map(t => t.id));
  const fresh = [...valueTips, ...newAiTips].filter(t => !existingIds.has(t.id));
  if (fresh.length) { history = [...fresh, ...history]; saveHistory(); }

  // 5. Telegram üzenet
  let msg = `🏆 <b>VIP Value Tipster – ${new Date().toLocaleString("hu-HU")}</b>\n\n`;

  if (valueTips.length) {
    msg += `📊 <b>VALUE TIPPEK (Pinnacle alapú)</b>\n`;
    msg += `<i>Matematikailag igazolt piaci előny</i>\n\n`;
    valueTips.forEach(t => {
      msg += `${t.sportLabel} <b>${t.match}</b>\n`;
      msg += `📌 ${t.market} → <b>${t.pick}</b>\n`;
      msg += `💰 Odds: ${t.odds} | Fair: ${t.fairOdds} | Value: <b>+${t.value.toFixed(1)}%</b>\n`;
      msg += `📐 Kelly tét: <b>${t.kelly}%</b> a bankrollból\n\n`;
    });
  } else {
    msg += `📊 <b>VALUE TIPPEK</b>\nMa nincs +6% feletti value lehetőség.\n\n`;
  }

  if (newAiTips.length) {
    msg += `🤖 <b>AI ELEMZETT TIPPEK</b>\n`;
    msg += `<i>Forma és statisztika alapú javaslatok</i>\n\n`;
    newAiTips.forEach(t => {
      msg += `${t.sportLabel} <b>${t.match}</b>\n`;
      if (t.commence) msg += `🕐 ${t.commence} (magyar idő)\n`;
      msg += `📌 ${t.market} → <b>${t.pick}</b>\n`;
      msg += `💰 Odds: ${t.odds}\n`;
      msg += `💡 ${t.note}\n\n`;
    });
  }

  await sendTelegram(msg);
  console.log(`[${new Date().toLocaleTimeString("hu-HU")}] Frissítve – ${valueTips.length} value + ${newAiTips.length} AI tipp`);
}

// ── Ütemező ───────────────────────────────────────────────
function scheduleNextFetch() {
  const { hour, minute, day } = getHungarianTime();
  const isWeekend  = day === 0 || day === 5 || day === 6;
  const fetchHours = isWeekend ? [10, 15, 19] : [15];
  let msUntilNext  = null;
  for (const h of fetchHours) {
    const minsLeft = (h - hour) * 60 - minute;
    if (minsLeft > 0) { msUntilNext = minsLeft * 60 * 1000; break; }
  }
  if (!msUntilNext) {
    const minsToMidnight = (24 - hour) * 60 - minute;
    const tomorrowDay    = (day + 1) % 7;
    const isWE           = tomorrowDay === 0 || tomorrowDay === 5 || tomorrowDay === 6;
    msUntilNext          = (minsToMidnight + (isWE ? 10 : 15) * 60) * 60 * 1000;
  }
  console.log(`Következő lekérés: ${Math.round(msUntilNext / 60000)} perc múlva (magyar idő)`);
  setTimeout(() => { fetchAndProcess(); scheduleNextFetch(); }, msUntilNext);
}

// ── Napi 23:00 statisztika ────────────────────────────────
setInterval(() => {
  const { hour, minute } = getHungarianTime();
  if (hour === EOD_HOUR && minute === 0) {
    const won  = history.filter(t => t.result === "won").length;
    const lost = history.filter(t => t.result === "lost").length;
    const avg  = history.filter(t => t.value).length
      ? (history.filter(t => t.value).reduce((s, t) => s + t.value, 0) / history.filter(t => t.value).length).toFixed(1)
      : "–";
    sendTelegram(`📈 <b>Napi stat – ${new Date().toLocaleDateString("hu-HU")}</b>\n\nÖsszes tipp: ${history.length}\n✅ Nyert: ${won}\n❌ Vesztett: ${lost}\n📊 Átl. value (value tippeknél): +${avg}%`);
  }
}, 60000);

// ── API végpontok ─────────────────────────────────────────
app.get("/api/tips",    (req, res) => res.json({ valueTips: latestTips, aiTips }));
app.get("/api/history", (req, res) => res.json(history));

app.get("/api/status", (req, res) => {
  const { hour, minute, day } = getHungarianTime();
  const isWeekend  = day === 0 || day === 5 || day === 6;
  const fetchHours = isWeekend ? [10, 15, 19] : [15];
  let msUntilNext  = null;
  for (const h of fetchHours) {
    const minsLeft = (h - hour) * 60 - minute;
    if (minsLeft > 0) { msUntilNext = minsLeft * 60 * 1000; break; }
  }
  if (!msUntilNext) {
    const minsToMidnight = (24 - hour) * 60 - minute;
    const tomorrowDay    = (day + 1) % 7;
    const isWE           = tomorrowDay === 0 || tomorrowDay === 5 || tomorrowDay === 6;
    msUntilNext          = (minsToMidnight + (isWE ? 10 : 15) * 60) * 60 * 1000;
  }
  res.json({ valueTipsCount: latestTips.length, aiTipsCount: aiTips.length, lastUpdate: history[0]?.addedAt || null, nextFetchMs: msUntilNext, isWeekend, fetchHours });
});

app.post("/api/refresh", async (req, res) => {
  await fetchAndProcess();
  res.json({ ok: true, valueTips: latestTips.length, aiTips: aiTips.length });
});

app.patch("/api/history/:id", (req, res) => {
  const { result } = req.body;
  history    = history.map(t => t.id === req.params.id ? { ...t, result } : t);
  latestTips = latestTips.map(t => t.id === req.params.id ? { ...t, result } : t);
  aiTips     = aiTips.map(t => t.id === req.params.id ? { ...t, result } : t);
  saveHistory();
  res.json({ ok: true });
});

app.post("/api/stats/send", async (req, res) => {
  const won  = history.filter(t => t.result === "won").length;
  const lost = history.filter(t => t.result === "lost").length;
  const avg  = history.filter(t => t.value).length
    ? (history.filter(t => t.value).reduce((s, t) => s + t.value, 0) / history.filter(t => t.value).length).toFixed(1)
    : "–";
  await sendTelegram(`📈 <b>Napi stat – ${new Date().toLocaleDateString("hu-HU")}</b>\n\nÖsszes tipp: ${history.length}\n✅ Nyert: ${won}\n❌ Vesztett: ${lost}\n📊 Átl. value: +${avg}%`);
  res.json({ ok: true });
});

// ── Indítás ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VIP Tipster fut: http://localhost:${PORT}`));

fetchAndProcess();
scheduleNextFetch();

// Eredmények ellenőrzése óránként
setInterval(checkResults, 60 * 60 * 1000);
checkResults();
