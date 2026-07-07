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
const FOOTBALLDATA_TOKEN = process.env.FOOTBALLDATA_TOKEN;   // opcionális: 90 perces eredményhez (football-data.org)
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

let history    = loadHistory();
console.log(`History betöltve: ${history.length} tipp`);

// Meglévő duplikált kombik eltávolítása (azonos láb-halmaz). Lezártat előnyben tartunk,
// egyébként a legrégebbit; a duplikátumokat töröljük.
(function dedupeExistingCombos() {
  const combos = history.filter(t => t.type === "combo").sort((a, b) => {
    const sa = (a.result && a.result !== "pending") ? 0 : 1;
    const sb = (b.result && b.result !== "pending") ? 0 : 1;
    return sa - sb || (a.addedAt || "").localeCompare(b.addedAt || "");
  });
  const seen = new Set(), remove = new Set();
  for (const c of combos) {
    const k = comboKey(c);
    if (seen.has(k)) remove.add(c.id); else seen.add(k);
  }
  if (remove.size) {
    history = history.filter(t => !remove.has(t.id));
    saveHistory();
    console.log(`Duplikált kombik eltávolítva: ${remove.size}`);
  }
})();

// Pending (még le nem zárt) AI tippek visszaállítása szerver-újraindítás után.
// FONTOS: dátumtól függetlenül minden pending tipp visszakerül, mert egy tipp
// gyakran az előző napon lett felvéve a mai/esti meccsre – ezeknek is látszaniuk kell.
let latestTips = [];   // (megszűnt value tippek – üresen tartva a kompatibilitásért)
let aiTips     = history.filter(t => t.type === "ai"    && (!t.result || t.result === "pending"));
let comboTips  = history.filter(t => t.type === "combo" && (!t.result || t.result === "pending"));
console.log(`Visszaállítva: ${aiTips.length} AI tipp + ${comboTips.length} kombi`);

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

// Csak foci AI tippek: a value tippeket és a nem-foci sportágakat kihagyjuk.
function isFootballAi(t) {
  if (t.type === "value") return false;
  return /soccer|foci|⚽/i.test((t.sport || "") + " " + (t.sportLabel || ""));
}

// ── Statisztika számítás (csak foci, value nélkül) ────────
function calcStats() {
  const tips     = history.filter(isFootballAi);
  const won      = tips.filter(t => t.result === "won").length;
  const lost     = tips.filter(t => t.result === "lost").length;
  const push     = tips.filter(t => t.result === "push").length;
  const halfWon  = tips.filter(t => t.result === "half_won").length;
  const halfLost = tips.filter(t => t.result === "half_lost").length;
  const pend     = tips.filter(t => !t.result || t.result === "pending").length;
  const settled  = tips.filter(t => SETTLED.includes(t.result));
  const profit   = settled.reduce((s,t) => s + tipProfit(t), 0);
  // Win% – a fél eredmények fél súllyal, a visszajárók (push) kihagyva
  const decidedW = won + halfWon * 0.5;
  const decidedN = won + lost + halfWon + halfLost;
  const wr        = decidedN ? ((decidedW/decidedN)*100).toFixed(0)+"%" : "–";
  const roi       = settled.length ? ((profit/settled.length)*100).toFixed(1) : "–";
  const profitStr = settled.length ? (profit>=0?"+":"")+profit.toFixed(2) : "–";
  const roiStr    = roi!=="–" ? (profit>=0?"+":"")+roi+"%" : "–";
  return { total: tips.length, won, lost, push, halfWon, halfLost, pend, wr, profitStr, roiStr };
}

// Egy kombi profitja egységben (comboPayout - 1); lezáratlannál 0.
function comboProfit(t) {
  if (!SETTLED.includes(t.result)) return 0;
  const payout = t.comboPayout != null ? t.comboPayout
               : (t.result === "won" ? (parseFloat(t.odds) || 0) : t.result === "push" ? 1 : 0);
  return payout - 1;
}
// ── Kombi statisztika (külön a singlektől) ────────────────
function calcComboStats() {
  const c       = history.filter(t => t.type === "combo");
  const settled = c.filter(t => SETTLED.includes(t.result));
  const won     = c.filter(t => t.result === "won").length;
  const lost    = c.filter(t => t.result === "lost").length;
  const pend    = c.filter(t => !t.result || t.result === "pending").length;
  const profit  = settled.reduce((s,t) => s + comboProfit(t), 0);
  const roi     = settled.length ? ((profit/settled.length)*100).toFixed(1) : "–";
  return { total: c.length, won, lost, pend, settled: settled.length,
    profitStr: settled.length ? (profit>=0?"+":"")+profit.toFixed(2) : "–",
    roiStr: roi!=="–" ? (profit>=0?"+":"")+roi+"%" : "–" };
}

function buildStatsMsg(title) {
  const { total, won, lost, push, halfWon, halfLost, pend, wr, profitStr, roiStr } = calcStats();
  const pushTotal = push + halfWon + halfLost;   // a fél eredmények a visszajárhoz számítanak
  const cs = calcComboStats();
  const comboSection = cs.total ? `\n\n🎰 <b>Kombi tippek</b> <i>(külön)</i>\n`+
    `Nyert/Vesztett: <b>${cs.won}</b> / <b>${cs.lost}</b> (folyamatban: ${cs.pend})\n`+
    `Profit: <b>${cs.profitStr} egység</b> · ROI: <b>${cs.roiStr}</b>` : "";
  return `📈 <b>${title}</b>\n`+
    `📅 ${new Date().toLocaleDateString("hu-HU")}\n`+
    `<i>Csak foci tippek (value nélkül)</i>\n\n`+
    `📊 <b>Összesítés</b>\n`+
    `Összes tipp: <b>${total}</b>\n`+
    `⏳ Folyamatban: <b>${pend}</b>\n`+
    `✅ Nyert: <b>${won}</b>\n`+
    `❌ Vesztett: <b>${lost}</b>\n`+
    `↩️ Visszajár: <b>${pushTotal}</b>\n\n`+
    `📉 <b>Teljesítmény</b>\n`+
    `Win %: <b>${wr}</b>\n`+
    `Profit: <b>${profitStr} egység</b>\n`+
    `ROI: <b>${roiStr}</b>`+
    comboSection;
}

// ── AI tippek ─────────────────────────────────────────────
// Visszatér: { singles: [...], comboLegs: [...] }
async function fetchAiTips(matchList, alreadyTipped = []) {
  if (!ANTHROPIC_KEY || !matchList.length) return { singles: [], comboLegs: [] };
  console.log(`AI elemzés: ${matchList.length} meccs`);

  const matchText = matchList.map(m =>
    `- ${m.sport} | ${m.match} | Kezdés: ${m.commence}\n  Valós odds: ${m.odds.map(o => `${o.market} / ${o.name}: ${o.odds} (${o.bookmaker})`).join(", ")}`
  ).join("\n");

  const skipNote = alreadyTipped.length
    ? `\nEZEKRE A MECCSEKRE MÁR VAN SINGLE TIPP – NE adj rájuk újabb SINGLE tippet (de kombi lábnak felhasználhatod): ${alreadyTipped.join("; ")}\n`
    : "";

  const prompt = `Te egy profi labdarúgás-fogadási elemző vagy. Használj web keresést az aktuális formához, sérülésekhez és keretinformációkhoz az alábbi mai foci meccsekre.

Mai meccsek (valós bookmaker oddsokkal):
${matchText}
${skipNote}
KÉT dolgot adj:

1) "tippek": 2-3 ERŐS single tipp (csak a legjobbak, ne erőltesd a számot).
   - Csak pozitív kimenetel: over gólok, hendikep győzelem, csapat győzelme. NE adj under tippet a singlekbe.

2) "kombi_labak": 3-4 BIZTONSÁGOS, alacsony kockázatú láb KÜLÖNBÖZŐ meccsekről, kombi szelvényhez.
   - Ezek külön-külön NEM elég értékesek single tippnek (alacsony odds, jellemzően 1.15-1.55), de kombinálva szép össz oddsot adnak.
   - Magas valószínűségű kimenetelek: erős favorit győzelme, Over 1.5, Under 4.5, hendikep -1 / -1.5 nagy favoritnál stb.
   - MINDEGYIK láb MÁS meccsről legyen.

KÖZÖS szabályok:
- Az "odds" mezőbe CSAK a fent megadott valós bookmaker oddsok egyikét írd (a megfelelő piac/kimenet oddsát).
- A "market" és "pick" pontosan egyezzen egy valós piaccal/kimenettel; a csapatnév a fent megadott formában szerepeljen.
- Rövid (1-2 mondat) magyar indoklás valós adatok alapján (csak a "tippek"-hez kell note).

Válaszolj KIZÁRÓLAG egy JSON OBJEKTUMMAL, semmi más szöveg nélkül:
{"tippek":[{"match":"...","sport":"soccer","sportLabel":"⚽ FIFA VB 2026","commence":"07.05 20:00","market":"1X2","pick":"...","odds":1.85,"note":"..."}],"kombi_labak":[{"match":"...","sportLabel":"⚽ FIFA VB 2026","commence":"07.05 20:00","market":"Over 1.5","pick":"Over 1.5","odds":1.28}]}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 5000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await r.json();
    const text = (data.content?.filter(b => b.type === "text").map(b => b.text) || []).join("\n");
    const found = text.match(/\{[\s\S]*\}/);
    if (!found) { console.log("AI: nem sikerült JSON-t kinyerni\n" + text.slice(0, 300)); return { singles: [], comboLegs: [] }; }
    let obj;
    try { obj = JSON.parse(found[0]); } catch { console.log("AI: JSON parse hiba"); return { singles: [], comboLegs: [] }; }
    const singles = (Array.isArray(obj.tippek) ? obj.tippek : []).map(t => ({
      id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: "ai", sport: t.sport, sportLabel: t.sportLabel,
      match: t.match, commence: t.commence || null,
      market: t.market, pick: t.pick, odds: t.odds,
      live: false, note: t.note,
      addedAt: nowHu(), result: "pending"
    }));
    const comboLegs = (Array.isArray(obj.kombi_labak) ? obj.kombi_labak : []).map(l => ({
      match: l.match, sportLabel: l.sportLabel || "⚽",
      market: l.market, pick: l.pick, odds: parseFloat(l.odds) || 0, commence: l.commence || null
    })).filter(l => l.match && l.market && l.pick && l.odds > 1);
    return { singles, comboLegs };
  } catch (e) { console.error("AI tipp hiba:", e.message); return { singles: [], comboLegs: [] }; }
}

function comboHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }
// Egy kombi láb-halmaz kulcsa (sorrendtől független) – ez alapján dedupolunk.
function comboKey(c) { return (c.legs || []).map(l => `${l.match}|${l.market}|${l.pick}`).sort().join("__"); }
// ── Kombi tippek (csak az izgalom kedvéért) ───────────────
// 2-es és 3-as kötés az AI által adott BIZTONSÁGOS kombi lábakból, KÜLÖNBÖZŐ meccsekről.
// Minden láb önállóan, közvetlenül a meccs eredménye alapján dől el.
function buildCombos(legs) {
  const byMatch = {};
  for (const l of legs) {
    if (!l.match || !l.odds) continue;
    if (!byMatch[l.match] || l.odds < byMatch[l.match].odds) byMatch[l.match] = l;   // meccsenként a legbiztosabb
  }
  const pool = Object.values(byMatch).sort((a, b) => a.odds - b.odds);
  const mk = (items, n) => {
    const legsArr = items.map(l => ({
      match: l.match, sportLabel: l.sportLabel, market: l.market,
      pick: l.pick, odds: l.odds, commence: l.commence || null, result: null
    }));
    const odds = parseFloat(legsArr.reduce((p, l) => p * l.odds, 1).toFixed(2));
    const id   = "combo-" + n + "-" + comboHash(comboKey({ legs: legsArr }));
    return {
      id, type: "combo", legN: n, legs: legsArr, odds, comboPayout: null,
      note: `${n} lábas kötés – csak az izgalom kedvéért`,
      addedAt: nowHu(), result: "pending"
    };
  };
  const combos = [];
  if (pool.length >= 2) combos.push(mk(pool.slice(0, 2), 2));
  if (pool.length >= 3) combos.push(mk(pool.slice(0, 3), 3));
  return combos;
}

// ── Fő frissítő ───────────────────────────────────────────
async function fetchAndProcess() {
  const now   = new Date();
  const today = todayHU();
  console.log(`Elemzés indul: ${new Date().toLocaleString("hu-HU", { timeZone: "Europe/Budapest" })}`);

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
        // (Nincs meccs-kihagyás: a teljes lista kell a kombi lábakhoz is; a single
        //  duplikátumot a prompt + a válasz utólagos szűrése kezeli.)

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

  const { singles, comboLegs } = await fetchAiTips(matchList, [...todayAiMatches]);

  // Backstop: a már ma tippelt meccsekre ne kerüljön újabb SINGLE (a prompt mellett is szűrünk)
  const newAiTips = singles.filter(t => !todayAiMatches.has(t.match));

  // Új single tippek hozzáadása a history-hoz (a meglévők megtartásával)
  const existingIds = new Set(history.map(t => t.id));
  const fresh = newAiTips.filter(t => !existingIds.has(t.id));
  if (fresh.length) { history = [...fresh, ...history]; saveHistory(); }
  saveLastRun();

  // A főoldal MINDEN még le nem zárt (pending) AI tippet mutasson (a korábbi futásokét is).
  aiTips = history.filter(t => t.type === "ai" && (!t.result || t.result === "pending"));

  // Kombi tippek (külön, csak az izgalom kedvéért) – az AI biztonságos lábaiból.
  // Új single nélkül is jöhet friss kombi, de a KORÁBBIVAL azonos láb-halmazú NEM
  // duplikálódik (a dedup a lábakat nézi, nem az azonosítót).
  const existingKeys = new Set(history.filter(t => t.type === "combo").map(comboKey));
  const freshCombos = buildCombos(comboLegs).filter(c => !existingKeys.has(comboKey(c)));
  if (freshCombos.length) { history = [...freshCombos, ...history]; saveHistory(); }
  comboTips = history.filter(t => t.type === "combo" && (!t.result || t.result === "pending"));

  let msg = `🏆 <b>AI Foci Tippek – ${new Date().toLocaleString("hu-HU", { timeZone: "Europe/Budapest" })}</b>\n\n`;
  if (fresh.length) {
    msg += `🤖 <b>ÚJ AI TIPPEK</b>\n<i>Web keresés, forma és statisztika alapján</i>\n\n`;
    fresh.forEach(t => {
      msg += `${t.sportLabel} <b>${t.match}</b>\n`;
      if (t.commence) msg += `🕐 ${t.commence}\n`;
      msg += `📌 ${t.market} → <b>${t.pick}</b>\n💰 Odds: ${t.odds}\n💡 ${t.note}\n\n`;
    });
  } else {
    msg += `Ebben a futásban nincs új tipp.\n`;
  }
  if (freshCombos.length) {
    msg += `\n🎰 <b>KOMBI TIPPEK</b> <i>(csak az izgalom kedvéért)</i>\n\n`;
    freshCombos.forEach(c => {
      msg += `<b>${c.legN} lábas kötés – Össz odds: ${c.odds}</b>\n`;
      c.legs.forEach(l => { msg += `  • ${l.match}: ${l.pick} (${l.odds})\n`; });
      msg += `\n`;
    });
  }
  await sendTelegram(msg);
  console.log(`Frissítve – ${fresh.length} új AI tipp, ${freshCombos.length} új kombi (élő: ${aiTips.length} single, ${comboTips.length} kombi)`);
}

// ── football-data.org: 90 perces (rendes idejű) eredmény ──
// A fogadások a rendes játékidőre dőlnek el (90' + hosszabbítás[stoppage], de
// hosszabbítás/tizenegyes nélkül). Az odds API a hosszabbítással együtti végeredményt
// adja, ami kieséses meccseknél hibás. A football-data.org score.regularTime a 90 perces
// eredmény – ha be van állítva a FOOTBALLDATA_TOKEN, ezt használjuk a kiértékeléshez.
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
function fdTeamNames(t) {
  return [t?.name, t?.shortName, t?.tla].filter(Boolean).map(normTeam);
}
function fdMatchFixture(game, matches) {
  const kt = new Date(game.commence_time).getTime();
  const nh = normTeam(game.home_team), na = normTeam(game.away_team);
  for (const m of matches) {
    const fkt = new Date(m.utcDate || 0).getTime();
    if (Math.abs(fkt - kt) > 20 * 60000) continue;                 // ±20 perc a kezdéshez horgony
    const homeOk = fdTeamNames(m.homeTeam).some(x => nameSim(nh, x));
    const awayOk = fdTeamNames(m.awayTeam).some(x => nameSim(na, x));
    if (homeOk && awayOk) return m;                                // hazai↔hazai, vendég↔vendég
  }
  return null;
}
// 90 perces eredmény kinyerése: regularTime ha van, különben fullTime
// (REGULAR meccsnél a fullTime = 90 perc). A mezőnevek eltérhetnek (home/away vagy homeTeam/awayTeam).
function fdScore90(m) {
  const pick = o => o && (o.home != null || o.homeTeam != null)
    ? { home: +(o.home ?? o.homeTeam), away: +(o.away ?? o.awayTeam) } : null;
  const s = m.score || {};
  return pick(s.regularTime) || pick(s.fullTime);
}
async function fdMatchesForDate(dateStr, cache) {
  if (!FOOTBALLDATA_TOKEN) return null;
  if (dateStr in cache) return cache[dateStr];
  const to = new Date(new Date(dateStr + "T00:00:00Z").getTime() + 86400000).toISOString().slice(0, 10);
  const url = `https://api.football-data.org/v4/matches?dateFrom=${dateStr}&dateTo=${to}`;   // 1 napos ablak (ingyenes csomag ezt engedi)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(url, { headers: { "X-Auth-Token": FOOTBALLDATA_TOKEN } });
      const body = await r.text();
      if (r.ok) {
        const list = Array.isArray(JSON.parse(body).matches) ? JSON.parse(body).matches : [];
        console.log(`football-data.org ${dateStr}: ${list.length} meccs`);
        cache[dateStr] = list;
        return list;
      }
      if (attempt === 1) { await new Promise(res => setTimeout(res, 1500)); continue; }   // átmeneti hiba → 1 újrapróba
      console.log(`football-data.org HTTP ${r.status} (${dateStr}): ${body.slice(0, 150)}`);
    } catch (e) {
      if (attempt === 1) { await new Promise(res => setTimeout(res, 1500)); continue; }
      console.error(`football-data.org hiba (${dateStr}):`, e.message);
    }
  }
  cache[dateStr] = null;
  return null;
}
// Visszatér: { home, away, status } a 90 perces eredménnyel, vagy null ha nincs megbízható párosítás.
async function regulationScore(game, cache) {
  if (!FOOTBALLDATA_TOKEN) return null;
  const base = new Date(game.commence_time);
  const dates = [base.toISOString().slice(0, 10)];
  const nxt = new Date(base.getTime() + 6 * 3600000).toISOString().slice(0, 10);
  if (nxt !== dates[0]) dates.push(nxt);                            // UTC éjfélen átnyúló kezdés
  for (const d of dates) {
    const fx = await fdMatchesForDate(d, cache);
    if (!fx) continue;
    const m = fdMatchFixture(game, fx);
    if (m && m.status === "FINISHED") {
      const sc = fdScore90(m);
      if (sc && sc.home != null) return { home: sc.home, away: sc.away, status: m.score?.duration || "FINISHED" };
    }
  }
  return null;
}

// Egy piac kiértékelése a 90 perces eredmény alapján. Visszatér:
// won / lost / push / half_won / half_lost, vagy null ha nem értelmezhető.
function settleMarket(market, pick, homeTeam, awayTeam, homeScore, awayScore) {
  const mk = (market || "").toLowerCase();
  if (market === "1X2") {
    // Három kimenet: csapattippnél döntetlen = vereség (push nincs).
    if (pick === homeTeam) return homeScore >  awayScore ? "won" : "lost";
    if (pick === awayTeam) return awayScore >  homeScore ? "won" : "lost";
    if (pick === "Draw")   return homeScore === awayScore ? "won" : "lost";
    return null;
  }
  if (mk.includes("over")) {
    const line = parseFloat(market.match(/[\d.]+/)?.[0] || 0);
    return settleQuarter(homeScore + awayScore, line);            // ázsiai over is (2.75 stb.)
  }
  if (mk.includes("under")) {
    const line = parseFloat(market.match(/[\d.]+/)?.[0] || 0);
    const r = settleQuarter(homeScore + awayScore, line);         // Under = az Over ellentettje
    return r === "won" ? "lost" : r === "lost" ? "won"
         : r === "half_won" ? "half_lost" : r === "half_lost" ? "half_won" : r;
  }
  if (mk.includes("hendikep") || mk.includes("handicap")) {
    const lineMatch = (pick || "").match(/-?[\d.]+$/);
    if (!lineMatch) return null;
    const h      = parseFloat(lineMatch[0]);                      // pl. +0.75 / -1.5
    const isHome = pick.includes(homeTeam);
    const d      = isHome ? homeScore - awayScore : awayScore - homeScore;
    return settleQuarter(d, -h);
  }
  if (mk.includes("btts") || mk.includes("mindkét")) {
    return homeScore > 0 && awayScore > 0 ? "won" : "lost";
  }
  return null;
}

// ── Eredményjelölés ───────────────────────────────────────
async function checkResults() {
  const pendingSingles = history.filter(t => t.type === "ai"    && (t.result === "pending" || !t.manual));
  const pendingCombos  = history.filter(t => t.type === "combo" && (!t.result || t.result === "pending"));
  if (!pendingSingles.length && !pendingCombos.length) return;
  console.log(`Eredmények ellenőrzése (${pendingSingles.length} single, ${pendingCombos.length} kombi)...`);
  let changed = false;
  const fdCache = {};

  // 1. Befejezett meccsek 90 perces eredményének összegyűjtése (meccsnév → eredmény)
  const completed = {};
  for (const sportKey of Object.keys(SPORT_MAP)) {
    try {
      const r = await fetch(`https://api.the-odds-api.com/v4/sports/${sportKey}/scores/?apiKey=${ODDS_API_KEY}&daysFrom=3`);
      if (!r.ok) continue;
      const games = await r.json();
      for (const game of games) {
        if (!game.completed || !game.scores) continue;
        const matchName = `${game.home_team} vs ${game.away_team}`;
        let homeScore = parseInt(game.scores.find(s => s.name === game.home_team)?.score || 0);
        let awayScore = parseInt(game.scores.find(s => s.name === game.away_team)?.score || 0);
        let src = "odds";
        const reg = await regulationScore(game, fdCache);
        if (reg) { homeScore = reg.home; awayScore = reg.away; src = `90'(${reg.status})`; }
        completed[matchName] = { home_team: game.home_team, away_team: game.away_team, homeScore, awayScore, id: game.id, src };
      }
    } catch (e) { console.error(`Scores hiba (${sportKey}):`, e.message); }
  }

  const findGame = tip => completed[tip.match] || Object.values(completed).find(g => g.id === tip.matchId);

  // 2. Single tippek kiértékelése
  for (const tip of pendingSingles) {
    const g = findGame(tip);
    if (!g) continue;
    const result = settleMarket(tip.market, tip.pick, g.home_team, g.away_team, g.homeScore, g.awayScore);
    if (!result) { console.log(`    ✗ ${tip.market}/${tip.pick} – nem értékelhető`); continue; }
    if (tip.result === result && tip.homeScore != null) continue;
    const fix = tip.result && tip.result !== "pending" && tip.result !== result ? " (JAVÍTÁS)" : "";
    console.log(`  ${g.home_team} vs ${g.away_team}: ${g.homeScore}-${g.awayScore} [${g.src}] · ${tip.pick} → ${result}${fix}`);
    const patch = { result, homeScore: g.homeScore, awayScore: g.awayScore, settledAt: nowHu() };
    history = history.map(t => t.id === tip.id ? { ...t, ...patch } : t);
    aiTips  = aiTips.map(t => t.id === tip.id ? { ...t, ...patch } : t);
    changed = true;
  }

  // 3. Kombik – MINDEN láb önállóan a meccs eredménye alapján
  for (const combo of pendingCombos) {
    const legRes = combo.legs.map(leg => {
      const g = completed[leg.match];
      return g ? settleMarket(leg.market, leg.pick, g.home_team, g.away_team, g.homeScore, g.awayScore) : null;
    });
    if (legRes.some(r => !r)) continue;   // van még nyitott / nem értékelhető láb
    const mults = legRes.map((r, i) => {
      const o = parseFloat(combo.legs[i].odds) || 0;
      switch (r) {
        case "won":       return o;
        case "half_won":  return (1 + o) / 2;
        case "push":      return 1;
        case "half_lost": return 0.5;
        default:          return 0;       // lost
      }
    });
    const payout = mults.reduce((a, b) => a * b, 1);
    const result = payout > 1.0001 ? "won" : payout < 0.9999 ? "lost" : "push";
    const legs   = combo.legs.map((l, i) => ({ ...l, result: legRes[i] }));   // lábak eredménye a megjelenítéshez
    const patch  = { result, comboPayout: parseFloat(payout.toFixed(2)), legs, settledAt: nowHu() };
    history   = history.map(t => t.id === combo.id ? { ...t, ...patch } : t);
    comboTips = comboTips.map(t => t.id === combo.id ? { ...t, ...patch } : t);
    changed = true;
    console.log(`  KOMBI (${combo.legN} lábas) → ${result} (x${patch.comboPayout})`);
  }

  if (changed) { saveHistory(); console.log("Eredmények mentve ✓"); }
  else console.log("Nincs új lezárt meccs.");
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

// ── Napnyitó: 00:03 eredmény-ellenőrzés, 00:05 statisztika (magyar idő) ──
let _lastCheckDay = "", _lastStatsDay = "";
setInterval(async () => {
  const { hour, minute } = getHungarianTime();
  const dayKey = todayHU();                       // naponta egyszer, dupla lefutás ellen
  if (hour === 0 && minute === 3 && _lastCheckDay !== dayKey) {
    _lastCheckDay = dayKey;
    console.log("Napnyitó automatikus eredmény-ellenőrzés...");
    await checkResults();
  }
  if (hour === 0 && minute === 5 && _lastStatsDay !== dayKey) {
    _lastStatsDay = dayKey;
    await sendTelegram(buildStatsMsg("Napi statisztika"));
  }
}, 60000);

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
app.get("/api/tips",    (req, res) => res.json({ aiTips, comboTips }));
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
  res.json({ aiTipsCount: aiTips.length, lastUpdate: history[0]?.addedAt || null, nextFetchMs: minsUntilNext * 60 * 1000, isWeekend, fetchHours });
});

app.post("/api/refresh", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  await fetchAndProcess();
  res.json({ ok: true, aiTips: aiTips.length });
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
  comboTips  = [];
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
  await sendTelegram(buildStatsMsg("AI Foci Tippek – Statisztika"));
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
app.listen(PORT, () => console.log(`AI Foci Tippek fut: http://localhost:${PORT}`));

if (!ADMIN_PWD) {
  console.warn("⚠️  FIGYELEM: ADMIN_PASSWORD nincs beállítva – az admin végpontok (törlés, eredményjelölés, stat-küldés, frissítés) VÉDTELENEK! Állítsd be a Render Environment Variables között.");
}
if (FOOTBALLDATA_TOKEN) {
  (async () => {
    try {
      const r = await fetch("https://api.football-data.org/v4/competitions", { headers: { "X-Auth-Token": FOOTBALLDATA_TOKEN } });
      if (!r.ok) {
        console.warn(`⚠️  football-data.org token NEM működik (HTTP ${r.status}). Ellenőrizd a FOOTBALLDATA_TOKEN értékét a Renderen.`);
        return;
      }
      const j = await r.json().catch(() => ({}));
      const comps = Array.isArray(j.competitions) ? j.competitions : [];
      const codes = comps.map(c => c.code);
      const hasWC = codes.includes("WC");
      console.log(`✓ football-data.org bekötve – ${comps.length} elérhető sorozat${hasWC ? " (VB benne van ✓)" : " (⚠️ a VB [WC] NINCS a csomagban)"}. A kiértékelés a 90 perces eredményt használja.`);
    } catch (e) {
      console.warn("⚠️  football-data.org ellenőrzés sikertelen:", e.message);
    }
  })();
} else {
  console.log("ℹ️  football-data.org token (FOOTBALLDATA_TOKEN) nincs beállítva – a kiértékelés az odds API végeredményét használja (kieséses/hosszabbításos meccseknél pontatlan lehet).");
}

const lastRun = loadLastRun();
if (lastRun) console.log(`Utolsó futás: ${Math.round((Date.now() - new Date(lastRun).getTime()) / 60000)} perce`);
