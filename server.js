const express = require("express");
const fetch   = require("node-fetch");
const fs      = require("fs");
const path    = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use('/api/odds', require('./routes/odds'));

const ADMIN_PWD     = process.env.ADMIN_PASSWORD;
const ODDS_API_KEY  = process.env.ODDS_API_KEY;
const TG_BOT_TOKEN  = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID    = process.env.TG_CHAT_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const APIFOOTBALL_KEY = process.env.APIFOOTBALL_KEY;   // opcionális: 90 perces eredményhez
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

// ── Sport térkép (csak foci) ──────────────────────────────
const SPORT_MAP = {
  "soccer_fifa_world_cup":             { sport: "soccer", label: "⚽ FIFA VB 2026",    minValue: 6 },
  "soccer_uefa_champs_league":         { sport: "soccer", label: "⚽ BL",               minValue: 6 },
  "soccer_epl":                        { sport: "soccer", label: "⚽ Premier League",    minValue: 6 },
  "soccer_germany_bundesliga":         { sport: "soccer", label: "⚽ Bundesliga",        minValue: 6 },
  "soccer_spain_la_liga":              { sport: "soccer", label: "⚽ La Liga",           minValue: 6 },
  "soccer_italy_serie_a":              { sport: "soccer", label: "⚽ Serie A",           minValue: 6 },
  "soccer_france_ligue_one":           { sport: "soccer", label: "⚽ Ligue 1",           minValue: 6 },
  "soccer_conmebol_copa_libertadores": { sport: "soccer", label: "⚽ Copa Libertadores", minValue: 7 },
  "soccer_conmebol_copa_sudamericana": { sport: "soccer", label: "⚽ Copa Sudamericana", minValue: 7 },
};

const EXCLUDED_BM = ["betfair_ex_eu", "betfair_ex_uk", "matchbook", "betfair_sb_uk", "smarkets"];
const SHARP_BMS   = ["pinnacle", "pinnacle_au", "betsson", "nordicbet"];

let history    = loadHistory();
console.log(`History betöltve: ${history.length} tipp`);

// Pending (még le nem zárt) tippek visszaállítása szerver-újraindítás után.
// FONTOS: dátumtól függetlenül minden pending tipp visszakerül, mert egy tipp
// gyakran az előző napon lett felvéve a mai/esti meccsre – ezeknek is látszaniuk kell.
let latestTips = history.filter(t => t.type === "value" && (!t.result || t.result === "pending"));
let aiTips     = history.filter(t => t.type === "ai"    && (!t.result || t.result === "pending"));
console.log(`Visszaállítva: ${latestTips.length} value + ${aiTips.length} AI tipp`);

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
  // "2026. 07. 02. 23:31:14" → "2026. 07. 02." (nap, nem csak év)
  const p = new Date().toLocaleString("hu-HU", { timeZone: "Europe/Budapest" }).split(" ");
  return p.slice(0, 3).join(" ");
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

// ── Ázsiai kiértékelés ────────────────────────────────────
// Egész/fél vonal: won/lost/push. Negyedes vonal (x.25 / x.75): a tét két fél
// fogadásra bomlik a két szomszédos vonalon → won / half_won / push / half_lost / lost.
// x  = realizált érték (hendikepnél: sajátGól-ellenGól; over-nél: összGól)
// line = az a vonal, amit meg kell haladni a nyeréshez
function settleQuarter(x, line) {
  const L = Math.round(line * 4) / 4;            // 0.25-ös rácsra igazítás
  if (Number.isInteger(L * 2)) {                 // egész vagy fél vonal → egy fogadás
    return x > L ? "won" : x < L ? "lost" : "push";
  }
  const s1 = Math.sign(x - (L - 0.25));          // alsó fél-vonal
  const s2 = Math.sign(x - (L + 0.25));          // felső fél-vonal
  const sum = s1 + s2;                           // -2..+2
  if (sum === 2)  return "won";                  // mindkét fél nyer
  if (sum === 1)  return "half_won";             // egyik nyer, másik visszajár
  if (sum === -1) return "half_lost";            // egyik veszt, másik visszajár
  if (sum === 0)  return "push";                 // (negyedesnél gyakorlatilag nem fordul elő)
  return "lost";                                 // mindkét fél veszt
}

const SETTLED = ["won", "lost", "push", "half_won", "half_lost"];
// Egy lezárt tipp profitja egységben (1 = teljes tét).
function tipProfit(t) {
  const o = parseFloat(t.odds) || 0;
  switch (t.result) {
    case "won":       return o - 1;
    case "half_won":  return (o - 1) / 2;
    case "lost":      return -1;
    case "half_lost": return -0.5;
    default:          return 0;                  // push
  }
}
function nowHu() {
  return new Date().toLocaleString("hu-HU", { timeZone: "Europe/Budapest" });
}

// ── Statisztika számítás ──────────────────────────────────
function calcStats() {
  const won      = history.filter(t => t.result === "won").length;
  const lost     = history.filter(t => t.result === "lost").length;
  const push     = history.filter(t => t.result === "push").length;
  const halfWon  = history.filter(t => t.result === "half_won").length;
  const halfLost = history.filter(t => t.result === "half_lost").length;
  const pend     = history.filter(t => !t.result || t.result === "pending").length;
  const vTips    = history.filter(t => t.value);
  const avg      = vTips.length ? (vTips.reduce((s,t) => s+t.value,0)/vTips.length).toFixed(1) : "–";
  const settled  = history.filter(t => SETTLED.includes(t.result));
  const profit   = settled.reduce((s,t) => s + tipProfit(t), 0);
  // Win% – a fél eredmények fél súllyal, a visszajárók (push) kihagyva
  const decidedW = won + halfWon * 0.5;
  const decidedN = won + lost + halfWon + halfLost;
  const wr        = decidedN ? ((decidedW/decidedN)*100).toFixed(0)+"%" : "–";
  const roi       = settled.length ? ((profit/settled.length)*100).toFixed(1) : "–";
  const profitStr = settled.length ? (profit>=0?"+":"")+profit.toFixed(2) : "–";
  const roiStr    = roi!=="–" ? (profit>=0?"+":"")+roi+"%" : "–";
  // Closing line value – az igazi él-mutató
  const clvTips  = history.filter(t => typeof t.clv === "number");
  const avgClv   = clvTips.length ? (clvTips.reduce((s,t)=>s+t.clv,0)/clvTips.length).toFixed(1) : null;
  const clvBeat  = clvTips.length ? Math.round(clvTips.filter(t=>t.clv>0).length/clvTips.length*100) : null;
  return { won, lost, push, halfWon, halfLost, pend, avg, wr, profitStr, roiStr, avgClv, clvBeat, clvCount: clvTips.length };
}

function buildStatsMsg(title) {
  const { won, lost, push, halfWon, halfLost, pend, avg, wr, profitStr, roiStr, avgClv, clvBeat, clvCount } = calcStats();
  const pushTotal = push + halfWon + halfLost;   // a fél eredmények a visszajárhoz számítanak
  const clvLine = avgClv != null
    ? `📐 Átl. CLV: <b>${avgClv>=0?"+":""}${avgClv}%</b> (${clvBeat}% verte a zárót, n=${clvCount})\n`
    : "";
  return `📈 <b>${title}</b>\n`+
    `📅 ${new Date().toLocaleDateString("hu-HU")}\n\n`+
    `📊 <b>Összesítés</b>\n`+
    `Összes tipp: <b>${history.length}</b>\n`+
    `⏳ Folyamatban: <b>${pend}</b>\n`+
    `✅ Nyert: <b>${won}</b>\n`+
    `❌ Vesztett: <b>${lost}</b>\n`+
    `↩️ Visszajár: <b>${pushTotal}</b>\n\n`+
    `📉 <b>Teljesítmény</b>\n`+
    `Win %: <b>${wr}</b>\n`+
    `Profit: <b>${profitStr} egység</b>\n`+
    `ROI: <b>${roiStr}</b>\n`+
    clvLine+
    `Átl. value: <b>+${avg}%</b>`;
}

// ── Value tippek ──────────────────────────────────────────
// Vig-mentes fair valószínűség több sharp iroda konszenzusából.
// A Pinnacle-t kétszeres súllyal vesszük (leginkább éles). Visszatér:
// { probs: {kimenetNév: valószínűség}, count } vagy null, ha nincs használható sharp.
function sharpConsensus(sharpBMs) {
  const acc = {};   // név -> { sum, w }
  let count = 0;
  for (const bm of sharpBMs) {
    const outs = bm.markets?.[0]?.outcomes;
    if (!outs || outs.length < 2) continue;
    const overround = outs.reduce((s, o) => s + 1 / o.price, 0);
    if (overround < 1.0 || overround > 1.12) continue;      // csak reális margójú vonal
    const w = (bm.key === "pinnacle" || bm.key === "pinnacle_au") ? 2 : 1;
    for (const o of outs) {
      const p = (1 / o.price) / overround;                  // vig-mentes valószínűség
      if (!acc[o.name]) acc[o.name] = { sum: 0, w: 0 };
      acc[o.name].sum += p * w;
      acc[o.name].w   += w;
    }
    count++;
  }
  if (!count) return null;
  const probs = {};
  for (const name in acc) probs[name] = acc[name].sum / acc[name].w;
  return { probs, count };
}

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
        if (softBMs.length < 2) continue;   // legalább 2 soft iroda kell (konszenzus + anti-outlier)

        // Vig-mentes FAIR valószínűség több sharp iroda konszenzusából (Pinnacle dupla súllyal)
        const consensus = sharpConsensus(sharpBMs);
        if (!consensus) continue;
        const { probs: fairProb, count: sharpN } = consensus;

        for (const name of Object.keys(fairProb)) {
          const trueProb = fairProb[name];
          const fairOdds = parseFloat((1 / trueProb).toFixed(2));

          // Minden soft ár erre a kimenetre, csökkenő sorrendben
          const prices = [];
          for (const bm of softBMs) {
            const o = bm.markets[0]?.outcomes?.find(x => x.name === name);
            if (o) prices.push({ price: o.price, title: bm.title });
          }
          if (prices.length < 2) continue;
          prices.sort((a, b) => b.price - a.price);

          const odds   = parseFloat(prices[0].price.toFixed(2));
          const bestBM = prices[0].title;
          if (odds < 1.3 || odds > 6.0) continue;

          // ANTI-OUTLIER: a MÁSODIK legjobb soft ár is legyen a fair felett, hogy ne
          // egyetlen elavult/hibás iroda hozzon félrevezető "value"-t (ez volt a fő gond).
          if (prices[1].price <= fairOdds) continue;

          const value = parseFloat(((odds / fairOdds - 1) * 100).toFixed(1));
          if (value < meta.minValue || value > 30) continue;

          const kelly = parseFloat((((trueProb * odds - 1) / (odds - 1)) * 0.25 * 100).toFixed(1));
          if (kelly <= 0) continue;

          allTips.push({
            id: `${game.id}-${name}-${Date.now()}`,
            matchId: game.id,
            sportKey,
            type: "value",
            sport: meta.sport, sportLabel: meta.label,
            match: `${game.home_team} vs ${game.away_team}`,
            commence: huTime(game.commence_time),
            commenceISO: game.commence_time,
            market: "1X2", pick: name,
            odds, fairOdds, prob: Math.round(trueProb * 100), value, kelly,
            live: false,
            closingFair: null, clv: null,
            note: `Legjobb odds: ${bestBM} | Fair (${sharpN} sharp konszenzus): ${fairOdds}`,
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

  const prompt = `Te egy profi labdarúgás-fogadási elemző vagy. Használj web keresést hogy megtudd az aktuális formát, sérüléseket, és keretinformációkat az alábbi mai foci meccsekre, majd adj 2-3 konkrét fogadási tippet — csak akkor többet, ha valóban több erős lehetőség van. Ne erőltesd a tippszámot.

Mai meccsek (valós bookmaker oddsokkal):
${matchText}

Szabályok:
- Csak OVER típusú vagy pozitív kimenetelű tippek (over gólok, hendikep győzelem, csapat győzelme)
- NE adj under típusú tippet
- KÖTELEZŐ: az odds mezőbe CSAK a fent megadott valós bookmaker oddsok egyikét írd be
- Adj rövid (2-3 mondatos) magyar nyelvű indoklást VALÓS adatok alapján
- Maximum 3 tipp összesen, csak a legerősebb lehetőségeket válaszd

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
  if (newAiTips.length) {
    msg += `🤖 <b>AI ELEMZETT TIPPEK</b>\n<i>Web keresés, forma és statisztika alapján</i>\n\n`;
    newAiTips.forEach(t => {
      msg += `${t.sportLabel} <b>${t.match}</b>\n`;
      if (t.commence) msg += `🕐 ${t.commence}\n`;
      msg += `📌 ${t.market} → <b>${t.pick}</b>\n💰 Odds: ${t.odds}\n💡 ${t.note}\n\n`;
    });
  }
  await sendTelegram(msg);
  console.log(`Frissítve – ${valueTips.length} value + ${newAiTips.length} AI tipp`);
}

// ── API-Football: 90 perces (rendes idejű) eredmény ───────
// A fogadások a rendes játékidőre dőlnek el (90' + hosszabbítás[stoppage], de
// hosszabbítás/tizenegyes nélkül). Az odds API a hosszabbítással együtti végeredményt
// adja, ami kieséses meccseknél hibás. Az API-Football score.fulltime a 90 perces
// eredmény – ha be van állítva az APIFOOTBALL_KEY, ezt használjuk a kiértékeléshez.
function normTeam(s) {
  return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(fc|cf|sc|afc|cd|ac|ss|ssc|as|rc|fk|sk|club|deportivo|united|city)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}
function levDist(a, b) {
  const m = a.length, n = b.length, d = [];
  for (let i = 0; i <= m; i++) d[i] = [i];
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return d[m][n];
}
function nameSim(a, b) {
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  return levDist(a, b) <= Math.max(2, Math.floor(Math.min(a.length, b.length) * 0.25));
}
function afMatchFixture(game, fixtures) {
  const kt = new Date(game.commence_time).getTime();
  const nh = normTeam(game.home_team), na = normTeam(game.away_team);
  for (const f of fixtures) {
    const fkt = new Date(f.fixture?.date || 0).getTime();
    if (Math.abs(fkt - kt) > 20 * 60000) continue;                 // ±20 perc a kezdéshez horgony
    if (nameSim(nh, normTeam(f.teams?.home?.name)) &&
        nameSim(na, normTeam(f.teams?.away?.name))) return f;      // hazai↔hazai, vendég↔vendég
  }
  return null;
}
async function afFixturesForDate(dateStr, cache) {
  if (!APIFOOTBALL_KEY) return null;
  if (dateStr in cache) return cache[dateStr];
  try {
    const r = await fetch(`https://v3.football.api-sports.io/fixtures?date=${dateStr}`,
      { headers: { "x-apisports-key": APIFOOTBALL_KEY } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.log(`API-Football HTTP ${r.status} (${dateStr})`); cache[dateStr] = null; return null; }
    const errs = j.errors;
    const hasErr = errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length);
    if (hasErr) { console.log(`API-Football hibaüzenet (${dateStr}): ${JSON.stringify(errs)}`); cache[dateStr] = null; return null; }
    const list = Array.isArray(j.response) ? j.response : [];
    console.log(`API-Football ${dateStr}: ${list.length} meccs`);
    cache[dateStr] = list;
    return list;
  } catch (e) { console.error("API-Football hiba:", e.message); cache[dateStr] = null; return null; }
}
// Visszatér: { home, away, status } a 90 perces eredménnyel, vagy null ha nincs megbízható párosítás.
async function regulationScore(game, cache) {
  if (!APIFOOTBALL_KEY) return null;
  const base = new Date(game.commence_time);
  const dates = [base.toISOString().slice(0, 10)];
  const nxt = new Date(base.getTime() + 6 * 3600000).toISOString().slice(0, 10);
  if (nxt !== dates[0]) dates.push(nxt);                            // UTC éjfélen átnyúló kezdés
  for (const d of dates) {
    const fx = await afFixturesForDate(d, cache);
    if (!fx) continue;
    const f = afMatchFixture(game, fx);
    const st = f?.fixture?.status?.short;
    if (f && ["FT", "AET", "PEN"].includes(st) && f.score?.fulltime?.home != null) {
      return { home: +f.score.fulltime.home, away: +f.score.fulltime.away, status: st };
    }
  }
  return null;
}

// ── Eredményjelölés ───────────────────────────────────────
async function checkResults() {
  // Kiértékelendő: minden pending tipp, PLUSZ minden nem kézzel jelölt tipp
  // (visszamenőleges javítás – a scores ablakban (daysFrom=3) lévő meccsek eredménye
  //  újraértékelődik, így a korábbi hibás kiértékelések maguktól helyreállnak).
  const work = history.filter(t => t.result === "pending" || !t.manual);
  if (!work.length) return;
  console.log(`Eredmények ellenőrzése (${work.length} tipp, ebből pending: ${work.filter(t=>t.result==="pending").length})...`);
  let changed = false;
  const afCache = {};   // API-Football napi fixture-cache egy futásra

  for (const sportKey of Object.keys(SPORT_MAP)) {
    try {
      const r = await fetch(`https://api.the-odds-api.com/v4/sports/${sportKey}/scores/?apiKey=${ODDS_API_KEY}&daysFrom=3`);
      if (!r.ok) continue;
      const games = await r.json();
      for (const game of games) {
        if (!game.completed || !game.scores) continue;
        const matchName = `${game.home_team} vs ${game.away_team}`;
        const tips = work.filter(t => t.matchId === game.id || t.match === matchName);
        if (!tips.length) continue;

        let homeScore = parseInt(game.scores.find(s => s.name === game.home_team)?.score || 0);
        let awayScore = parseInt(game.scores.find(s => s.name === game.away_team)?.score || 0);
        let src = "odds";
        const reg = await regulationScore(game, afCache);   // 90 perces eredmény, ha elérhető
        if (reg) { homeScore = reg.home; awayScore = reg.away; src = `90'(${reg.status})`; }
        console.log(`  ${matchName}: ${homeScore}-${awayScore} [${src}]`);

        for (const tip of tips) {
          let result = null;
          const mk = (tip.market || "").toLowerCase();
          if (tip.market === "1X2") {
            // 1X2 (három kimenet): csapattippnél SOSINCS push – döntetlen = vereség.
            // (A hosszabbítás/tizenegyesek nem számítanak, a scores API rendes idő + hosszabbítás
            //  eredményt ad; tizenegyes-döntésnél a döntetlen megmarad, tehát a csapattipp vesztes.)
            if (tip.pick === game.home_team)      result = homeScore >  awayScore ? "won" : "lost";
            else if (tip.pick === game.away_team) result = awayScore >  homeScore ? "won" : "lost";
            else if (tip.pick === "Draw")         result = homeScore === awayScore ? "won" : "lost";
          } else if (mk.includes("over")) {
            const line  = parseFloat(tip.market.match(/[\d.]+/)?.[0] || 0);
            result = settleQuarter(homeScore + awayScore, line);      // ázsiai over is (2.75 stb.)
          } else if (mk.includes("hendikep")) {
            const lineMatch = tip.pick.match(/-?[\d.]+$/);
            if (!lineMatch) continue;
            const h      = parseFloat(lineMatch[0]);                  // pl. +0.75
            const isHome = tip.pick.includes(game.home_team);
            const d      = isHome ? homeScore - awayScore : awayScore - homeScore;
            result = settleQuarter(d, -h);                            // nyer, ha (sajátGól + h) > ellenGól
          } else if (mk.includes("btts") || mk.includes("mindkét")) {
            result = homeScore > 0 && awayScore > 0 ? "won" : "lost";
          }
          if (!result) { console.log(`    ✗ ${tip.market} / ${tip.pick} – nem sikerült kiértékelni`); continue; }
          // Ha már pontosan ez az eredmény van tárolva (a végeredménnyel együtt), ne írjuk felül
          if (tip.result === result && tip.homeScore != null) continue;
          if (tip.result && tip.result !== "pending" && tip.result !== result)
            console.log(`    ↻ JAVÍTÁS: ${tip.pick} ${tip.result} → ${result}`);
          else
            console.log(`    ${tip.pick} → ${result}`);
          const patch = { result, homeScore, awayScore, settledAt: nowHu() };
          history    = history.map(t => t.id === tip.id ? { ...t, ...patch } : t);
          latestTips = latestTips.map(t => t.id === tip.id ? { ...t, ...patch } : t);
          aiTips     = aiTips.map(t => t.id === tip.id ? { ...t, ...patch } : t);
          changed    = true;
        }
      }
    } catch (e) { console.error(`Scores hiba (${sportKey}):`, e.message); }
  }
  if (changed) { saveHistory(); console.log("Eredmények mentve ✓"); }
  else console.log("Nincs új lezárt meccs.");
}

// ── Closing line value (CLV) rögzítése ────────────────────
// A kezdéshez közel (vagy röviddel utána) elmentjük a záró sharp fair oddsot,
// és kiszámoljuk, mennyivel vertük a záró vonalat. Ez az igazi él-mutató:
// tartósan pozitív átlag-CLV = valódi edge; negatív = nincs él (nem csak balszerencse).
async function captureClosingOdds() {
  const now = Date.now();
  const targets = history.filter(t =>
    t.type === "value" && t.result === "pending" &&
    t.closingFair == null && t.matchId && t.sportKey && t.commenceISO
  );
  if (!targets.length) return;

  // Csak azokat a sportokat kérdezzük le, ahol van a kezdés körüli ablakban lévő tipp
  // (így nem pazaroljuk az odds API kvótát).
  const bySport = {};
  for (const t of targets) {
    const mins = (new Date(t.commenceISO).getTime() - now) / 60000;
    if (mins <= 15 && mins >= -45) (bySport[t.sportKey] = bySport[t.sportKey] || []).push(t);
  }
  const sportKeys = Object.keys(bySport);
  if (!sportKeys.length) return;

  let changed = false;
  for (const sportKey of sportKeys) {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal&dateFormat=iso`;
      const r = await fetch(url);
      if (!r.ok) continue;
      const games = await r.json();
      for (const t of bySport[sportKey]) {
        const game = games.find(g => g.id === t.matchId);
        if (!game) continue;
        const sharpBMs = (game.bookmakers || []).filter(bm =>
          SHARP_BMS.includes(bm.key) &&
          bm.markets?.[0]?.outcomes?.every(o => o.price > 1.05 && o.price < 30)
        );
        const c = sharpConsensus(sharpBMs);
        if (!c || c.probs[t.pick] == null) continue;
        const closingFair = parseFloat((1 / c.probs[t.pick]).toFixed(2));
        const clv = parseFloat(((parseFloat(t.odds) / closingFair - 1) * 100).toFixed(1));
        const patch = { closingFair, clv };
        history    = history.map(x => x.id === t.id ? { ...x, ...patch } : x);
        latestTips = latestTips.map(x => x.id === t.id ? { ...x, ...patch } : x);
        changed = true;
        console.log(`  CLV: ${t.match} / ${t.pick} → ${clv >= 0 ? "+" : ""}${clv}% (odds ${t.odds} vs záró fair ${closingFair})`);
      }
    } catch (e) { console.error(`CLV hiba (${sportKey}):`, e.message); }
  }
  if (changed) saveHistory();
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

// ── CLV rögzítés – 6 percenként, csak ha van kezdés körüli value tipp ──
setInterval(captureClosingOdds, 6 * 60 * 1000);

// ── Admin hitelesítés ─────────────────────────────────────
// Jelszó jöhet: x-admin-password header, body.password, vagy ?password= query.
function requireAdmin(req, res) {
  if (!ADMIN_PWD) {
    // Ha nincs jelszó beállítva, nyitva marad – de erről induláskor figyelmeztetünk.
    return true;
  }
  const pwd = req.get("x-admin-password") || req.body?.password || req.query?.password;
  if (pwd !== ADMIN_PWD) {
    res.status(403).json({ error: "Hozzáférés megtagadva — hibás vagy hiányzó admin jelszó." });
    return false;
  }
  return true;
}

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
  if (!requireAdmin(req, res)) return;
  await fetchAndProcess();
  res.json({ ok: true, valueTips: latestTips.length, aiTips: aiTips.length });
});

app.patch("/api/history/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { result } = req.body;
  const patch = { result, manual: true };       // kézi jelölést az auto-újraértékelés nem írja felül
  history    = history.map(t => t.id === req.params.id ? { ...t, ...patch } : t);
  latestTips = latestTips.map(t => t.id === req.params.id ? { ...t, ...patch } : t);
  aiTips     = aiTips.map(t => t.id === req.params.id ? { ...t, ...patch } : t);
  saveHistory();
  res.json({ ok: true });
});

app.delete("/api/history", (req, res) => {
  if (!requireAdmin(req, res)) return;
  history    = [];
  latestTips = [];
  aiTips     = [];
  saveHistory();
  console.log("History törölve ✓");
  res.json({ ok: true });
});

app.post("/api/check-results", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  await checkResults();
  res.json({ ok: true });
});

app.post("/api/stats/send", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  await sendTelegram(buildStatsMsg("VIP Value Tipster – Statisztika"));
  res.json({ ok: true });
});

// ── Analyzer history szinkronizáció ──────────────────────
function aPath(uid) {
  const safe = String(uid).replace(/[^a-z0-9]/g, '').slice(0, 32);
  return '/data/ah_' + safe + '.json';
}

app.get("/api/analyzer-history", (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.json([]);
  try {
    const p = aPath(uid);
    if (!fs.existsSync(p)) return res.json([]);
    res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch (e) { res.json([]); }
});

app.post("/api/analyzer-history", (req, res) => {
  const { uid, entry } = req.body;
  if (!uid || !entry) return res.status(400).json({ error: 'Hiányzó adat' });
  try {
    const p = aPath(uid);
    const hist = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
    const newHist = [entry, ...hist].slice(0, 50);
    fs.writeFileSync(p, JSON.stringify(newHist), 'utf8');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/analyzer-history", (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.status(400).json({ error: 'Hiányzó uid' });
  try {
    const p = aPath(uid);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Indítás ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VIP Tipster fut: http://localhost:${PORT}`));

if (!ADMIN_PWD) {
  console.warn("⚠️  FIGYELEM: ADMIN_PASSWORD nincs beállítva – az admin végpontok (törlés, eredményjelölés, stat-küldés, frissítés) VÉDTELENEK! Állítsd be a Render Environment Variables között.");
}
if (APIFOOTBALL_KEY) {
  (async () => {
    try {
      const r = await fetch("https://v3.football.api-sports.io/status", { headers: { "x-apisports-key": APIFOOTBALL_KEY } });
      const j = await r.json().catch(() => ({}));
      const errs = j.errors;
      const hasErr = errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length);
      if (!r.ok || hasErr) {
        console.warn(`⚠️  API-Football kulcs NEM működik a közvetlen végponton (HTTP ${r.status}) – hiba: ${JSON.stringify(errs || {})}. Ha RapidAPI-n fizettél elő, a kulcs csak a RapidAPI végponton jó – szólj, és átírom a kódot arra.`);
        return;
      }
      const sub = j.response?.subscription, req = j.response?.requests;
      console.log(`✓ API-Football bekötve – plan: ${sub?.plan}, aktív: ${sub?.active}, kérések ma: ${req?.current}/${req?.limit_day}. A kiértékelés a 90 perces eredményt használja.`);
    } catch (e) {
      console.warn("⚠️  API-Football státusz-ellenőrzés sikertelen:", e.message);
    }
  })();
} else {
  console.log("ℹ️  API-Football kulcs (APIFOOTBALL_KEY) nincs beállítva – a kiértékelés az odds API végeredményét használja (kieséses/hosszabbításos meccseknél pontatlan lehet).");
}

const lastRun = loadLastRun();
if (lastRun) console.log(`Utolsó futás: ${Math.round((Date.now() - new Date(lastRun).getTime()) / 60000)} perce`);
