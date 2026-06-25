const express = require("express");
const fetch   = require("node-fetch");
const fs      = require("fs");
const path    = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const ODDS_API_KEY  = process.env.ODDS_API_KEY;
const TG_BOT_TOKEN  = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID    = process.env.TG_CHAT_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const EOD_HOUR      = 23;
const DATA_FILE     = "/data/history.json";
const SCHEDULE_FILE = "/data/lastRun.json";

// ── Perzisztens tárolás ───────────────────────────────────
function loadHistory() {
  try {
    if (!fs.existsSync("/data")) fs.mkdirSync("/data", { recursive: true });
    if (!fs.existsSync(DATA_FILE)) return [];
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) { console.error("History betöltési hiba:", e.message); return []; }
}

function saveHistory() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(history, null, 2), "utf8"); }
  catch (e) { console.error("History mentési hiba:", e.message); }
}

function loadLastRun() {
  try {
    if (!fs.existsSync(SCHEDULE_FILE)) return null;
    return JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf8")).lastRun || null;
  } catch { return null; }
}

function saveLastRun() {
  try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify({ lastRun: new Date().toISOString() }), "utf8"); }
  catch (e) { console.error("LastRun mentési hiba:", e.message); }
}

// ── Sport térkép ──────────────────────────────────────────
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
  "basketball_wnba":                   { sport: "basketball", label: "🏀 WNBA",                minValue: 12  },
  "basketball_euroleague":             { sport: "basketball", label: "🏀 Euroleague",           minValue: 8 },
  "icehockey_nhl":                     { sport: "hockey",     label: "🏒 NHL",                 minValue: 6 },
  "icehockey_ahl":                     { sport: "hockey",     label: "🏒 AHL",                 minValue: 9 },
};

const EXCLUDED_BM = ["betfair_ex_eu", "betfair_ex_uk", "matchbook", "betfair_sb_uk", "smarkets"];
const SHARP_BMS   = ["pinnacle", "pinnacle_au", "betsson", "nordicbet"];

let latestTips = [];
let aiTips     = [];
let history    = loadHistory();
console.log(`History betöltve: ${history.length} tipp`);

// ── Magyar idő ────────────────────────────────────────────
function getHungarianTime() {
  const huStr = new Date().toLocaleString("en-US", { timeZone: "Europe/Budapest", hour12: false });
  const hu    = new Date(huStr);
  return { hour: hu.getHours(), minute: hu.getMinutes(), day: hu.getDay() };
}

function huTime(isoDate) {
  return new Date(isoDate).toLocaleString("hu-HU", {
    timeZone: "Europe/Budapest", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  });
}

function todayHU() {
  return new Date().toLocaleString("hu-HU", { timeZone: "Europe/Budapest" }).split(" ")[0];
}

// ── Telegram ──────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    const r    = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML" })
    });
    const data = await r.json();
    if (!data.ok) console.error("Telegram hiba:", JSON.stringify(data));
    else console.log("Telegram: üzenet elküldve ✓");
  } catch (e) { console.error("Telegram hiba:", e.message); }
}

// ── Statisztika számítás ──────────────────────────────────
function calcStats() {
  const won    = history.filter(t => t.result === "won").length;
  const lost   = history.filter(t => t.result === "lost").length;
  const push   = history.filter(t => t.result === "push").length;
  const pend   = history.filter(t => !t.result || t.result === "pending").length;
  const vTips  = history.filter(t => t.value);
  const avg    = vTips.length ? (vTips.reduce((s,t) => s+t.value,0)/vTips.length).toFixed(1) : "–";
  const wr     = (won+lost) ? ((won/(won+lost))*100).toFixed(0)+"%" : "–";
  const closed = history.filter(t => t.result==="won"||t.result==="lost"||t.result==="push");
  let profit   = 0;
  closed.forEach(t => {
    if (t.result==="won")  profit += parseFloat(t.odds)-1;
    if (t.result==="lost") profit -= 1;
  });
  const roi       = closed.length ? ((profit/closed.length)*100).toFixed(1) : "–";
  const profitStr = closed.length ? (profit>=0?"+":"")+profit.toFixed(2) : "–";
  const roiStr    = roi!=="–" ? (profit>=0?"+":"")+roi+"%" : "–";
  return { won, lost, push, pend, avg, wr, profitStr, roiStr };
}

function buildStatsMsg(title) {
  const { won, lost, push, pend, avg, wr, profitStr, roiStr } = calcStats();
  return `📈 <b>${title}</b>\n`+
    `📅 ${new Date().toLocaleDateString("hu-HU")}\n\n`+
    `📊 <b>Összesítés</b>\n`+
    `Összes tipp: <b>${history.length}</b>\n`+
    `⏳ Folyamatban: <b>${pend}</b>\n`+
    `✅ Nyert: <b>${won}</b>\n`+
    `❌ Vesztett: <b>${lost}</b>\n`+
    `↩️ Visszajár: <b>${push}</b>\n\n`+
    `📉 <b>Teljesítmény</b>\n`+
    `Win %: <b>${wr}</b>\n`+
    `Profit: <b>${profitStr} egység</b>\n`+
    `ROI: <b>${roiStr}</b>\n`+
    `Átl. value: <b>+${avg}%</b>`;
}

// ── Value tippek ──────────────────────────────────────────
async function fetchValueTips() {
  const allTips = [];
  const now     = new Date();
  const today   = todayHU();
  const alreadyTipped = new Set(
    history.filter(t => t.type === "value" && t.addedAt?.startsWith(today)).map(t => t.matchId)
  );

  for (const [sportKey, meta] of Object.entries(SPORT_MAP)) {
    try {
      const url   = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal&dateFormat=iso`;
      const r     = await fetch(url);
      if (!r.ok) { console.log(`${sportKey}: HTTP ${r.status}`); continue; }
      const games = await r.json();
      console.log(`${sportKey}: ${games.length} meccs`);

      for (const game of games) {
        const hoursUntil = (new Date(game.commence_time) - now) / 3600000;
        if (hoursUntil < 0 || hoursUntil > 24) continue;
        if (alreadyTipped.has(game.id)) continue;

        const sharpBMs = (game.bookmakers || []).filter(bm =>
          SHARP_BMS.includes(bm.key) &&
          bm.markets?.[0]?.outcomes?.every(o => o.price > 1.05 && o.price < 30)
        );
        if (!sharpBMs.length) continue;

        const softBMs = (game.bookmakers || []).filter(bm =>
          !EXCLUDED_BM.includes(bm.key) &&
          !SHARP_BMS.includes(bm.key) &&
          bm.markets?.[0]?.outcomes?.every(o => o.price > 1.05 && o.price < 30)
        );
        if (!softBMs.length) continue;

        const sharpBM       = sharpBMs[0];
        const sharpOutcomes = sharpBM.markets[0].outcomes;
        if (sharpOutcomes.length < 2) continue;

        const overround = sharpOutcomes.reduce((s, o) => s + 1 / o.price, 0);
        if (overround < 1.0 || overround > 1.12) continue;

        for (const sharpO of sharpOutcomes) {
          let bestOdds = 0, bestBM = "";
          for (const bm of softBMs) {
            const o = bm.markets[0]?.outcomes?.find(x => x.name === sharpO.name);
            if (o && o.price > bestOdds) { bestOdds = o.price; bestBM = bm.title; }
          }
          if (!bestOdds) continue;

          const odds     = parseFloat(bestOdds.toFixed(2));
          if (odds < 1.3 || odds > 6.0) continue;

          const trueProb = (1 / sharpO.price) / overround;
          const fairOdds = parseFloat((1 / trueProb).toFixed(2));
          const value    = parseFloat(((odds / fairOdds - 1) * 100).toFixed(1));
          if (value < meta.minValue || value > 30) continue;

          const kelly = parseFloat((((trueProb * odds - 1) / (odds - 1)) * 0.25 * 100).toFixed(1));
          if (kelly <= 0) continue;

          allTips.push({
            id: `${game.id}-${sharpO.name}-${Date.now()}`,
            matchId: game.id,
            type: "value",
            sport: meta.sport, sportLabel: meta.label,
            match: `${game.home_team} vs ${game.away_team}`,
            commence: huTime(game.commence_time),
            market: "1X2", pick: sharpO.name,
            odds, fairOdds, prob: Math.round(trueProb * 100), value, kelly,
            live: false,
            note: `Legjobb odds: ${bestBM} | Fair odds (${sharpBM.title}): ${fairOdds}`,
            addedAt: new Date().toLocaleString("hu-HU", { timeZone: "Europe/Budapest" }),
            result: "pending"
          });
        }
      }
    } catch (e) { console.error(`Hiba (${sportKey}):`, e.message); }
  }
  return allTips.sort((a, b) => b.value - a.value).slice(0, 3);
}

// ── AI tippek ─────────────────────────────────────────────
async function fetchAiTips(matchList) {
  if (!ANTHROPIC_KEY || !matchList.length) return [];
  console.log(`AI elemzés: ${matchList.length} meccs`);

  const matchText = matchList.map(m =>
    `- ${m.sport} | ${m.match} | Kezdés: ${m.commence}\n  Valós odds: ${m.odds.map(o => `${o.market} / ${o.name}: ${o.odds} (${o.bookmaker})`).join(", ")}`
  ).join("\n");

  const prompt = `Te egy profi sportfogadási elemző vagy. Használj web keresést hogy megtudd az aktuális formát, sérüléseket, és keretinformációkat az alábbi mai meccsekre, majd adj 2-3 konkrét fogadási tippet.

Mai meccsek (valós bookmaker oddsokkal):
${matchText}

Szabályok:
- Csak OVER típusú vagy pozitív kimenetelű tippek (over gólok, hendikep győzelem, csapat győzelme)
- NE adj under típusú tippet
- KÖTELEZŐ: az odds mezőbe CSAK a fent megadott valós bookmaker oddsok egyikét írd be
- Adj rövid (2-3 mondatos) magyar nyelvű indoklást VALÓS adatok alapján

Válaszolj KIZÁRÓLAG JSON tömbként, semmi más szöveg nélkül:
[{"match":"...","sport":"soccer","sportLabel":"⚽ FIFA VB 2026","commence":"06.20. 20:00","market":"1X2","pick":"...","odds":1.85,"note":"..."}]`;

  try {
    const r    = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 4000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data   = await r.json();
    const blocks = data.content?.filter(b => b.type === "text") || [];
    const block  = blocks[blocks.length - 1];
    if (!block) { console.log("AI: nincs text blokk"); return []; }
    const found = block.text.match(/\[[\s\S]*\]/);
    if (!found) { console.log("AI: nem sikerült JSON-t kinyerni\n" + block.text.slice(0, 300)); return []; }
    return JSON.parse(found[0]).map(t => ({
      id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: "ai", sport: t.sport, sportLabel: t.sportLabel,
      match: t.match, commence: t.commence || null,
      market: t.market, pick: t.pick, odds: t.odds,
      fairOdds: null, prob: null, value: null, kelly: null,
      live: false, note: t.note,
      addedAt: new Date().toLocaleString("hu-HU", { timeZone: "Europe/Budapest" }),
      result: "pending"
    }));
  } catch (e) { console.error("AI tipp hiba:", e.message); return []; }
}

// ── Fő frissítő ───────────────────────────────────────────
async function fetchAndProcess() {
  const now   = new Date();
  const today = todayHU();
  console.log(`Elemzés indul: ${new Date().toLocaleString("hu-HU", { timeZone: "Europe/Budapest" })}`);

  const valueTips = await fetchValueTips();
  latestTips = valueTips;

  const todayAiMatches = new Set(
    history.filter(t => t.type === "ai" && t.addedAt?.startsWith(today)).map(t => t.match)
  );

  const matchList = [];
  for (const [sportKey, meta] of Object.entries(SPORT_MAP)) {
    try {
      const url   = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h,totals,spreads&oddsFormat=decimal&dateFormat=iso`;
      const r     = await fetch(url);
      if (!r.ok) continue;
      const games = await r.json();
      for (const game of games) {
        const hoursUntil = (new Date(game.commence_time) - now) / 3600000;
        if (hoursUntil < 0 || hoursUntil > 24) continue;
        if (todayAiMatches.has(`${game.home_team} vs ${game.away_team}`)) continue;

        const validBMs = (game.bookmakers || []).filter(bm => !EXCLUDED_BM.includes(bm.key) && bm.markets?.length > 0);
        if (validBMs.length < 2) continue;

        const h2hOdds = [];
        const h2hBMs  = validBMs.filter(bm => bm.markets.find(m => m.key === "h2h"));
        if (h2hBMs.length) {
          const names = h2hBMs[0].markets.find(m => m.key === "h2h").outcomes.map(o => o.name);
          names.forEach(name => {
            let best = 0, bestBM = "";
            for (const bm of h2hBMs) {
              const o = bm.markets.find(m => m.key === "h2h")?.outcomes?.find(x => x.name === name);
              if (o && o.price > best) { best = o.price; bestBM = bm.title; }
            }
            if (best) h2hOdds.push({ market: "1X2", name, odds: parseFloat(best.toFixed(2)), bookmaker: bestBM });
          });
        }

        const totalsOdds = [];
        const totalsBMs  = validBMs.filter(bm => bm.markets.find(m => m.key === "totals"));
        if (totalsBMs.length) {
          const best = {};
          for (const bm of totalsBMs) {
            for (const o of bm.markets.find(m => m.key === "totals")?.outcomes || []) {
              if (o.name !== "Over") continue;
              if (!best[o.point] || o.price > best[o.point].odds)
                best[o.point] = { market: `Over ${o.point}`, name: `Over ${o.point}`, odds: parseFloat(o.price.toFixed(2)), bookmaker: bm.title };
            }
          }
          totalsOdds.push(...Object.values(best));
        }

        const spreadsOdds = [];
        const spreadsBMs  = validBMs.filter(bm => bm.markets.find(m => m.key === "spreads"));
        if (spreadsBMs.length) {
          const best = {};
          for (const bm of spreadsBMs) {
            for (const o of bm.markets.find(m => m.key === "spreads")?.outcomes || []) {
              const key = `${o.name}_${o.point}`;
              if (!best[key] || o.price > best[key].odds)
                best[key] = { market: `Hendikep ${o.point > 0 ? "+" : ""}${o.point}`, name: `${o.name} ${o.point > 0 ? "+" : ""}${o.point}`, odds: parseFloat(o.price.toFixed(2)), bookmaker: bm.title };
            }
          }
          spreadsOdds.push(...Object.values(best));
        }

        const allOdds = [...h2hOdds, ...totalsOdds, ...spreadsOdds];
        if (allOdds.length) matchList.push({ sport: meta.label, match: `${game.home_team} vs ${game.away_team}`, commence: huTime(game.commence_time), odds: allOdds });
      }
    } catch {}
  }

  const newAiTips = await fetchAiTips(matchList);
  aiTips = newAiTips;

  const existingIds = new Set(history.map(t => t.id));
  const fresh = [...valueTips, ...aiTips].filter(t => !existingIds.has(t.id));
  if (fresh.length) { history = [...fresh, ...history]; saveHistory(); }
  saveLastRun();

  let msg = `🏆 <b>VIP Value Tipster – ${new Date().toLocaleString("hu-HU", { timeZone: "Europe/Budapest" })}</b>\n\n`;
  if (valueTips.length) {
    msg += `📊 <b>VALUE TIPPEK</b>\n<i>Pinnacle-alapú, matematikailag igazolt</i>\n\n`;
    valueTips.forEach(t => {
      msg += `${t.sportLabel} <b>${t.match}</b>\n🕐 ${t.commence}\n`;
      msg += `📌 ${t.market} → <b>${t.pick}</b>\n`;
      msg += `💰 Odds: ${t.odds} | Fair: ${t.fairOdds} | Value: <b>+${t.value.toFixed(1)}%</b>\n`;
      msg += `📐 Kelly tét: <b>${t.kelly}%</b>\n\n`;
    });
  } else {
    msg += `📊 <b>VALUE TIPPEK</b>\nMa nincs +6% feletti value.\n\n`;
  }
  if (aiTips.length) {
    msg += `🤖 <b>AI ELEMZETT TIPPEK</b>\n<i>Web keresés, forma és statisztika alapján</i>\n\n`;
    aiTips.forEach(t => {
      msg += `${t.sportLabel} <b>${t.match}</b>\n`;
      if (t.commence) msg += `🕐 ${t.commence}\n`;
      msg += `📌 ${t.market} → <b>${t.pick}</b>\n💰 Odds: ${t.odds}\n💡 ${t.note}\n\n`;
    });
  }
  await sendTelegram(msg);
  console.log(`Frissítve – ${valueTips.length} value + ${aiTips.length} AI tipp`);
}

// ── Eredményjelölés ───────────────────────────────────────
async function checkResults() {
  const pending = history.filter(t => t.result === "pending");
  if (!pending.length) return;
  console.log(`Eredmények ellenőrzése (${pending.length} pending)...`);
  let changed = false;

  for (const sportKey of Object.keys(SPORT_MAP)) {
    try {
      const r = await fetch(`https://api.the-odds-api.com/v4/sports/${sportKey}/scores/?apiKey=${ODDS_API_KEY}&daysFrom=2`);
      if (!r.ok) continue;
      const games = await r.json();
      for (const game of games) {
        if (!game.completed || !game.scores) continue;
        const tips = pending.filter(t => t.matchId === game.id);
        if (!tips.length) continue;
        const homeScore = parseInt(game.scores.find(s => s.name === game.home_team)?.score || 0);
        const awayScore = parseInt(game.scores.find(s => s.name === game.away_team)?.score || 0);
        for (const tip of tips) {
          let result = null;
          if (tip.market === "1X2") {
            if (tip.pick === game.home_team) result = homeScore > awayScore ? "won" : homeScore === awayScore ? "push" : "lost";
            else if (tip.pick === game.away_team) result = awayScore > homeScore ? "won" : homeScore === awayScore ? "push" : "lost";
            else if (tip.pick === "Draw") result = homeScore === awayScore ? "won" : "lost";
          } else if (tip.market.toLowerCase().includes("over")) {
            const line = parseFloat(tip.market.match(/[\d.]+/)?.[0] || 0);
            const total = homeScore + awayScore;
            result = total > line ? "won" : total === line ? "push" : "lost";
          } else if (tip.market.toLowerCase().includes("hendikep")) {
            const lineMatch = tip.pick.match(/-?[\d.]+$/);
            if (!lineMatch) continue;
            const line     = parseFloat(lineMatch[0]);
            const isHome   = tip.pick.includes(game.home_team);
            const adjScore = isHome ? homeScore + line : awayScore + line;
            const oppScore = isHome ? awayScore : homeScore;
            result = adjScore > oppScore ? "won" : adjScore === oppScore ? "push" : "lost";
          } else if (tip.market.toLowerCase().includes("btts") || tip.market.toLowerCase().includes("mindkét")) {
            result = homeScore > 0 && awayScore > 0 ? "won" : "lost";
          }
          if (!result) continue;
          console.log(`  ${game.home_team} vs ${game.away_team}: ${tip.pick} → ${result} (${homeScore}-${awayScore})`);
          history    = history.map(t => t.id === tip.id ? { ...t, result } : t);
          latestTips = latestTips.map(t => t.id === tip.id ? { ...t, result } : t);
          aiTips     = aiTips.map(t => t.id === tip.id ? { ...t, result } : t);
          changed    = true;
        }
      }
    } catch (e) { console.error(`Scores hiba (${sportKey}):`, e.message); }
  }
  if (changed) { saveHistory(); console.log("Eredmények mentve ✓"); }
}

// ── Ütemező ───────────────────────────────────────────────
function scheduleNextFetch() {
  const { hour, minute, day } = getHungarianTime();
  const isWeekend  = day === 0 || day === 5 || day === 6;
  const fetchHours = isWeekend ? [10, 15, 19] : [15];
  let minsUntilNext = null;
  for (const h of fetchHours) {
    const diff = (h - hour) * 60 - minute;
    if (diff > 0) { minsUntilNext = diff; break; }
  }
  if (!minsUntilNext) {
    const tomorrowDay = (day + 1) % 7;
    const isWE        = tomorrowDay === 0 || tomorrowDay === 5 || tomorrowDay === 6;
    minsUntilNext     = (24 - hour) * 60 - minute + (isWE ? 10 : 15) * 60;
  }
  const h = Math.floor(minsUntilNext / 60), m = minsUntilNext % 60;
  console.log(`Következő lekérés: ${h} óra ${m} perc múlva (magyar idő)`);
  setTimeout(() => { fetchAndProcess(); scheduleNextFetch(); }, minsUntilNext * 60 * 1000);
}

// ── Napi stat ─────────────────────────────────────────────
setInterval(() => {
  const { hour, minute } = getHungarianTime();
  if (hour === EOD_HOUR && minute === 0) {
    sendTelegram(buildStatsMsg("Napi statisztika"));
  }
}, 60000);

// ── API végpontok ─────────────────────────────────────────
app.get("/api/tips",    (req, res) => res.json({ valueTips: latestTips, aiTips }));
app.get("/api/history", (req, res) => res.json(history));

app.get("/api/status", (req, res) => {
  const { hour, minute, day } = getHungarianTime();
  const isWeekend  = day === 0 || day === 5 || day === 6;
  const fetchHours = isWeekend ? [10, 15, 19] : [15];
  let minsUntilNext = null;
  for (const h of fetchHours) {
    const diff = (h - hour) * 60 - minute;
    if (diff > 0) { minsUntilNext = diff; break; }
  }
  if (!minsUntilNext) {
    const tomorrowDay = (day + 1) % 7;
    const isWE        = tomorrowDay === 0 || tomorrowDay === 5 || tomorrowDay === 6;
    minsUntilNext     = (24 - hour) * 60 - minute + (isWE ? 10 : 15) * 60;
  }
  res.json({ valueTipsCount: latestTips.length, aiTipsCount: aiTips.length, lastUpdate: history[0]?.addedAt || null, nextFetchMs: minsUntilNext * 60 * 1000, isWeekend, fetchHours });
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

app.delete("/api/history", (req, res) => {
  history    = [];
  latestTips = [];
  aiTips     = [];
  saveHistory();
  console.log("History törölve ✓");
  res.json({ ok: true });
});

app.post("/api/stats/send", async (req, res) => {
  await sendTelegram(buildStatsMsg("VIP Value Tipster – Statisztika"));
  res.json({ ok: true });
});

// ── Indítás ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VIP Tipster fut: http://localhost:${PORT}`));

const lastRun = loadLastRun();
if (lastRun) console.log(`Utolsó futás: ${Math.round((Date.now() - new Date(lastRun).getTime()) / 60000)} perce`);

setInterval(checkResults, 60 * 60 * 1000);
setTimeout(checkResults, 30000);
