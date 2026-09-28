// server.js v2.34 | 2026-09-09
const express = require("express");
const fetch   = require("node-fetch");
const fs      = require("fs");
const path    = require("path");
const cookieParser = require("cookie-parser");

const usersDb = require("./users");
const auth    = require("./auth");
const mailer  = require("./mailer");

const app = express();

const security  = require("./lib/security");
const { requireAdmin, isAdminReq } = require("./lib/admin");
const stripeRoutes = require("./routes/stripe");

// Stripe webhook – express.raw a globális json middleware ELŐTT kell legyen!
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), stripeRoutes.webhook);

app.set("trust proxy", 1);                   // Render proxy mögött fut → req.ip a valódi kliens IP
app.use(express.json());
app.use(cookieParser());
app.use(auth.attachUser);                    // minden kérésre beteszi a req.user-t
app.use(express.static(path.join(__dirname, "public")));
app.use('/api/odds', require('./routes/odds'));

app.use("/api", security.safeJson);        // XSS-védelem minden API válaszra (lásd lib/security.js)
app.use(require("./routes/auth"));
app.use(require("./routes/adminUsers"));
app.use(stripeRoutes.router);
app.use(require("./routes/analyzer"));
const telegramBot = require("./routes/telegram")({ getHistory: () => history, isApproved: t => isApproved(t) });
app.use(telegramBot.router);

const ADMIN_PWD     = process.env.ADMIN_PASSWORD;
const ODDS_API_KEY  = process.env.ODDS_API_KEY;
const TG_BOT_TOKEN       = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID         = process.env.TG_CHAT_ID;           // publikus csatorna: -1004455319345
const TG_PRIVATE_CHAT_ID = process.env.TG_PRIVATE_CHAT_ID || "1326707238"; // admin privát
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FOOTBALLDATA_TOKEN = process.env.FOOTBALLDATA_TOKEN;   // opcionális: 90 perces eredményhez (football-data.org)
// ── Mondomatutit integráció ───────────────────────────────────
const MONDOMATUTIT_URL  = (process.env.MONDOMATUTIT_URL  || "https://mondomatutit.hu").replace(/\/$/, "");
const MONDOMATUTIT_PASS = process.env.MONDOMATUTIT_ADMIN_PASSWORD;
const DATA_DIR      = process.env.DATA_DIR || "/data";   // perzisztens lemez (Renderen /data)
const DATA_FILE     = path.join(DATA_DIR, "history.json");
const SCHEDULE_FILE = path.join(DATA_DIR, "lastRun.json");

// ── Perzisztens tárolás ───────────────────────────────────
function loadHistory() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
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
  // Nemzetközi / kupák
  "soccer_fifa_world_cup":               { sport: "soccer", label: "⚽ FIFA VB 2026" },
  "soccer_uefa_champs_league":           { sport: "soccer", label: "⚽ BL" },
  "soccer_uefa_europa_league":           { sport: "soccer", label: "⚽ EL" },
  "soccer_uefa_europa_conference_league":{ sport: "soccer", label: "⚽ Konferencia Liga" },
  "soccer_uefa_nations_league":          { sport: "soccer", label: "⚽ Nemzetek Ligája" },
  "soccer_conmebol_copa_libertadores":   { sport: "soccer", label: "⚽ Copa Libertadores" },
  "soccer_conmebol_copa_sudamericana":   { sport: "soccer", label: "⚽ Copa Sudamericana" },
  // Anglia
  "soccer_epl":                          { sport: "soccer", label: "⚽ Premier League" },
  "soccer_efl_champ":                    { sport: "soccer", label: "⚽ Championship" },
  "soccer_england_league1":              { sport: "soccer", label: "⚽ League One" },
  "soccer_england_league2":              { sport: "soccer", label: "⚽ League Two" },
  // Németország
  "soccer_germany_bundesliga":           { sport: "soccer", label: "⚽ Bundesliga" },
  "soccer_germany_bundesliga2":          { sport: "soccer", label: "⚽ 2. Bundesliga" },
  // Spanyolország
  "soccer_spain_la_liga":                { sport: "soccer", label: "⚽ La Liga" },
  "soccer_spain_segunda_division":       { sport: "soccer", label: "⚽ La Liga 2" },
  // Olaszország
  "soccer_italy_serie_a":                { sport: "soccer", label: "⚽ Serie A" },
  "soccer_italy_serie_b":                { sport: "soccer", label: "⚽ Serie B" },
  // Franciaország
  "soccer_france_ligue_one":             { sport: "soccer", label: "⚽ Ligue 1" },
  "soccer_france_ligue_two":             { sport: "soccer", label: "⚽ Ligue 2" },
  // Egyéb európai élvonalak
  "soccer_netherlands_eredivisie":       { sport: "soccer", label: "⚽ Eredivisie" },
  "soccer_scotland_premiership":         { sport: "soccer", label: "⚽ Skót Premiership" },
  "soccer_romania_liga1":               { sport: "soccer", label: "⚽ Román Liga 1" },
  "soccer_portugal_primeira_liga":       { sport: "soccer", label: "⚽ Primeira Liga" },
  "soccer_belgium_first_div":            { sport: "soccer", label: "⚽ Belga élvonal" },
  "soccer_turkey_super_league":          { sport: "soccer", label: "⚽ Török Szuperliga" },
  "soccer_greece_super_league":          { sport: "soccer", label: "⚽ Görög Szuperliga" },
  "soccer_switzerland_superleague":      { sport: "soccer", label: "⚽ Svájci Superliga" },
  "soccer_austria_bundesliga":           { sport: "soccer", label: "⚽ Osztrák Bundesliga" },
  "soccer_denmark_superliga":            { sport: "soccer", label: "⚽ Dán Superliga" },
  "soccer_norway_eliteserien":           { sport: "soccer", label: "⚽ Norvég Eliteserien" },
  "soccer_sweden_allsvenskan":           { sport: "soccer", label: "⚽ Svéd Allsvenskan" },
  "soccer_poland_ekstraklasa":           { sport: "soccer", label: "⚽ Lengyel Ekstraklasa" },
  // Amerika / Ázsia / Óceánia
  "soccer_brazil_campeonato":            { sport: "soccer", label: "⚽ Brazil Serie A" },
  "soccer_argentina_primera_division":   { sport: "soccer", label: "⚽ Argentin Primera" },
  "soccer_usa_mls":                      { sport: "soccer", label: "⚽ MLS" },
  "soccer_mexico_ligamx":                { sport: "soccer", label: "⚽ Liga MX" },
  "soccer_japan_j_league":               { sport: "soccer", label: "⚽ J1 League" },
  "soccer_australia_aleague":            { sport: "soccer", label: "⚽ A-League" },
};

const EXCLUDED_BM = ["betfair_ex_eu", "betfair_ex_uk", "matchbook", "betfair_sb_uk", "smarkets"];
const WINDOW_HOURS = 24;   // meddig előre nézzen a tippekhez/kombikhoz
const MIN_SINGLE_ODDS = 1.50;   // single tippnél minimum odds (a kombi lábakra NEM vonatkozik)

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
let freeTips = history.filter(t => t.type === "free" && (!t.result || t.result === "pending"));
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
// Admin privát üzenet (reggeli összegző, VIP tipp értesítő) – 1 retry timeout esetén
async function sendTelegram(text, attempt = 1) {
  if (!TG_BOT_TOKEN || !TG_PRIVATE_CHAT_ID) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_PRIVATE_CHAT_ID, text, parse_mode: "HTML" }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const data = await r.json();
    if (!data.ok) console.error("Telegram (privát) hiba:", JSON.stringify(data));
    else console.log("Telegram privát: üzenet elküldve ✓");
  } catch (e) {
    if (attempt === 1) {
      console.warn(`Telegram (privát) timeout/hiba – újrapróbálkozás 10s múlva...`);
      setTimeout(() => sendTelegram(text, 2), 10000);
    } else {
      console.error("Telegram (privát) hiba (2. kísérlet):", e.message);
    }
  }
}

// Publikus csatorna üzenet (csak ingyenes tippek)
async function sendToChannel(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    const r    = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML" })
    });
    const data = await r.json();
    if (!data.ok) console.error("Telegram (csatorna) hiba:", JSON.stringify(data));
    else console.log("Telegram csatorna: üzenet elküldve ✓");
  } catch (e) { console.error("Telegram (csatorna) hiba:", e.message); }
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

// AI tippek: foci meccsek elemzése valós odds és web keresés alapján.
function isFootballAi(t) {
  if (t.type === "value") return false;
  return /soccer|foci|⚽/i.test((t.sport || "") + " " + (t.sportLabel || ""));
}

// ── Statisztika számítás ──────────────────────────────────
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
  // Ugyanaz a számítás mint az /api/admin/stats endpointban → track record oldallal konzisztens
  const SETTLED_RES = ["won", "lost", "push", "half_won", "half_lost"];
  const allSettled = [...history, ...comboTips].filter(t => isApproved(t) && SETTLED_RES.includes(t.result));
  const won      = allSettled.filter(t => t.result === "won").length;
  const lost     = allSettled.filter(t => t.result === "lost").length;
  const halfWon  = allSettled.filter(t => t.result === "half_won").length;
  const halfLost = allSettled.filter(t => t.result === "half_lost").length;
  const push     = allSettled.filter(t => t.result === "push").length;
  const pend     = history.filter(t => isApproved(t) && (!t.result || t.result === "pending")).length;
  const decN     = won + lost + halfWon + halfLost;
  const wr       = decN ? (((won + halfWon * 0.5) / decN) * 100).toFixed(1) + "%" : "–";
  const profit   = allSettled.reduce((sum, t) => {
    if (t.type === "combo") {
      const p = parseFloat(t.comboPayout);
      return sum + (isNaN(p) ? (t.result === "won" ? (parseFloat(t.odds)||1)-1 : -1) : p - 1);
    }
    const o = parseFloat(t.odds) || 1;
    if (t.result === "won")       return sum + (o - 1);
    if (t.result === "lost")      return sum - 1;
    if (t.result === "half_won")  return sum + (o - 1) / 2;
    if (t.result === "half_lost") return sum - 0.5;
    return sum;
  }, 0);
  const roi       = allSettled.length ? ((profit / allSettled.length) * 100).toFixed(1) : "–";
  const profitStr = allSettled.length ? (profit >= 0 ? "+" : "") + profit.toFixed(2) : "–";
  const roiStr    = roi !== "–" ? (profit >= 0 ? "+" : "") + roi + "%" : "–";
  const pushTotal = push + halfWon + halfLost;

  return `📈 <b>${title}</b>\n`+
    `📅 ${new Date().toLocaleDateString("hu-HU")}\n\n`+
    `📊 <b>Összesítés</b> <i>(single + kombi + free)</i>\n`+
    `Lezárt tipp: <b>${allSettled.length}</b>\n`+
    `⏳ Folyamatban: <b>${pend}</b>\n`+
    `✅ Nyert: <b>${won}</b>\n`+
    `❌ Vesztett: <b>${lost}</b>\n`+
    `↩️ Visszajár: <b>${pushTotal}</b>\n\n`+
    `📉 <b>Teljesítmény</b>\n`+
    `Win %: <b>${wr}</b>\n`+
    `Profit: <b>${profitStr} egység</b>\n`+
    `ROI: <b>${roiStr}</b>`;
}

// ── Poisson value filter ──────────────────────────────────
// Valódi gólstatisztikákból (football-data.org tabella) becsüljük a várható gólszámot (λ),
// és ezt vetjük össze a fogadóirodák oddsaival. Csak azokra a ligákra működik, amelyekhez
// van football-data tabella (lásd FD_LABEL_MAP); a többi meccs Poisson-jelölés nélkül megy.

// Poisson P(X=k) – λ és k alapján
function _poissonPmf(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

// 1X2 + Over N + BTTS valószínűségek Poisson-modellel
function _computePoissonProbs(lambdaHome, lambdaAway, overLine = 2.5) {
  const MAX_GOALS = 10;
  let pH = 0, pD = 0, pA = 0, pBTTS = 0, pOver = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = _poissonPmf(lambdaHome, i) * _poissonPmf(lambdaAway, j);
      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;
      if (i > 0 && j > 0) pBTTS += p;
      if (i + j > overLine) pOver += p;
    }
  }
  return { home: pH, draw: pD, away: pA, btts: pBTTS, over: pOver };
}

const POISSON_EDGE_MIN   = 5.0;  // +5% edge felett "value" a piac
const POISSON_PRIOR_GAMES = 4;   // ennyi "átlagos" meccsel húzzuk a ligaátlag felé a csapatokat (kis minta ellen)
const POISSON_MIN_LEAGUE_GAMES = 10;  // ennél kevesebb lejátszott ligameccsnél nem modellezünk

// λ becslés a tabellából: támadó-/védekezőerő a lőtt/kapott gólokból, a ligaátlag felé húzva,
// a hazai pálya előnye a liga hazai/idegenbeli gólátlagából.
function _lambdaFromStandings(league, home, away) {
  const k = POISSON_PRIOR_GAMES;
  const avg = (league.homeAvg + league.awayAvg) / 2;           // gól / csapat / meccs
  const rate = (goals, played) => (goals + k * avg) / (played + k) / avg;
  const attH = rate(home.scored,   home.played), defH = rate(home.conceded, home.played);
  const attA = rate(away.scored,   away.played), defA = rate(away.conceded, away.played);
  return {
    lambdaHome: league.homeAvg * attH * defA,
    lambdaAway: league.awayAvg * attA * defH,
  };
}

// A fő value filter függvény: matchList bemenetre visszaadja a value market-eket meccsenként
// Visszatér: Map { matchName → { lambdaHome, lambdaAway, markets: [{market, name, modelProb, impliedProb, edge}], hasValue, valueMarkets } }
async function computePoissonEdge(matchList) {
  const result = new Map();
  let noLeague = 0, noTeam = 0;

  for (const m of matchList) {
    const code = FD_LABEL_MAP[m.sport];
    if (!code) { noLeague++; continue; }
    const stats = await getLeagueStats(code);
    if (!stats || stats.league.games < POISSON_MIN_LEAGUE_GAMES) { noLeague++; continue; }

    const parts = String(m.match || "").split(/\s+vs\.?\s+/i);
    if (parts.length !== 2) continue;
    const [homeName, awayName] = parts;
    const home = findTeam(stats.teams, homeName), away = findTeam(stats.teams, awayName);
    if (!home || !away || home === away) { noTeam++; continue; }

    const { lambdaHome, lambdaAway } = _lambdaFromStandings(stats.league, home, away);
    const base = _computePoissonProbs(lambdaHome, lambdaAway, 2.5);

    // Bookmaker implikált valószínűség a legjobb odds alapján
    const impliedProb = {};
    for (const o of (m.odds || [])) {
      const key = `${o.market}|${o.name}`;
      const imp = 1 / o.odds;
      if (!impliedProb[key] || imp < impliedProb[key]) impliedProb[key] = imp;
    }

    const markets = [];
    const addEdge = (market, name, modelProb) => {
      const imp = impliedProb[`${market}|${name}`];
      if (!imp) return;
      markets.push({ market, name,
        modelProb:   Math.round(modelProb * 1000) / 10,
        impliedProb: Math.round(imp * 1000) / 10,
        edge:        Math.round((modelProb - imp) * 1000) / 10 });
    };

    // 1X2
    for (const o of (m.odds || []).filter(o => o.market === "1X2")) {
      if (/^(draw|döntetlen|x)$/i.test(o.name)) addEdge("1X2", o.name, base.draw);
      else if (o.name === homeName) addEdge("1X2", o.name, base.home);
      else if (o.name === awayName) addEdge("1X2", o.name, base.away);
    }
    // Over / Under – csak .5-ös vonalak (a negyedes ázsiai vonalakat a modell nem kezeli)
    for (const o of (m.odds || []).filter(o => /^(Over|Under) \d+\.5$/.test(o.market))) {
      const line = parseFloat(o.market.split(" ")[1]);
      const pOver = _computePoissonProbs(lambdaHome, lambdaAway, line).over;
      addEdge(o.market, o.name, o.market.startsWith("Over") ? pOver : 1 - pOver);
    }

    const valueMarkets = markets.filter(mk => mk.edge >= POISSON_EDGE_MIN);
    result.set(m.match, {
      lambdaHome: Math.round(lambdaHome * 100) / 100,
      lambdaAway: Math.round(lambdaAway * 100) / 100,
      markets, hasValue: valueMarkets.length > 0, valueMarkets,
    });
  }

  const withValue = [...result.values()].filter(v => v.hasValue).length;
  console.log(`Poisson value filter (tabella alapú): ${result.size}/${matchList.length} meccs modellezve, ${withValue} meccsnél +${POISSON_EDGE_MIN}%+ edge` +
    (noLeague || noTeam ? ` · kihagyva: ${noLeague} (nincs tabella a ligához), ${noTeam} (csapat nem azonosítható)` : ""));
  return result;
}

// Egy generált tipphez tartozó Poisson-adat (a tippel együtt eltároljuk, hogy később
// kiértékelhető legyen: a value-s tippek tényleg jobban teljesítenek-e).
function poissonForTip(pe, market, pick, match) {
  if (!pe) return null;
  const txt = x => String(x || "").toLowerCase().replace(/,/g, ".");
  const mk = txt(market), pk = txt(pick);
  const lineM = (mk.match(/\d+\.5/) || pk.match(/\d+\.5/));
  let found = null;
  if (lineM && /under|kevesebb/.test(pk + " " + mk)) found = pe.markets.find(x => x.market === `Under ${lineM[0]}`);
  else if (lineM && /over|több/.test(pk + " " + mk))  found = pe.markets.find(x => x.market === `Over ${lineM[0]}`);
  else if (mk === "1x2" || /győzelem|döntetlen|draw/.test(pk)) {
    const [home, away] = String(match || "").split(/\s+vs\.?\s+/i);
    const oneX2 = pe.markets.filter(x => x.market === "1X2");
    if (/^(x|döntetlen|draw)$/.test(pk.trim())) found = oneX2.find(x => /^(draw|döntetlen|x)$/i.test(x.name));
    else if (/hazai|^1$/.test(pk.trim())) found = oneX2.find(x => x.name === home);
    else if (/vendég|^2$/.test(pk.trim())) found = oneX2.find(x => x.name === away);
    else found = oneX2.find(x => !/^(draw|döntetlen|x)$/i.test(x.name) && findTeam({ [x.name]: { name: x.name } }, pick));
  }
  return found
    ? { edge: found.edge, modelProb: found.modelProb, impliedProb: found.impliedProb, value: found.edge >= POISSON_EDGE_MIN }
    : null;
}

// ── AI tippek ─────────────────────────────────────────────
// Visszatér: { singles: [...], comboLegs: [...] }
async function fetchAiTips(matchList, alreadyTipped = [], poissonEdge = new Map()) {
  if (!ANTHROPIC_KEY || !matchList.length) return { singles: [], comboLegs: [] };

  // Maximum 20 meccs küldése Claude-nak – 28+ meccs esetén a JSON levágódik a token limit miatt.
  // Prioritás: top ligák előre, azon belül legkorábbi kezdés.
  const LEAGUE_PRIORITY = [
    "Premier League","La Liga","Bundesliga","Serie A","Ligue 1","Champions League",
    "Europa League","Conference League","Eredivisie","Primeira Liga","Championship",
    "Skót Premiership","Román Liga 1","MLS","Brasileirao","Argentin Primera","Liga MX"
  ];
  const sorted = [...matchList].sort((a, b) => {
    const pa = LEAGUE_PRIORITY.findIndex(l => (a.sport||"").includes(l));
    const pb = LEAGUE_PRIORITY.findIndex(l => (b.sport||"").includes(l));
    const ra = pa === -1 ? 99 : pa;
    const rb = pb === -1 ? 99 : pb;
    return ra !== rb ? ra - rb : 0;
  });
  const capped = sorted.slice(0, 20);
  if (matchList.length > 20) console.log(`AI elemzés: ${matchList.length} meccsből top 20 küldve (liga prioritás szerint)`);
  console.log(`AI elemzés: ${capped.length} meccs`);

  const matchText = capped.map(m => {
    const oddsStr = m.odds.map(o => `${o.market} / ${o.name}: ${o.odds} (${o.bookmaker})`).join(", ");
    let standingsStr = "";
    if (m.homeStandings || m.awayStandings) {
      const fmt = (d, name) => d
        ? `${name}: ${d.position}. hely | ${d.points}p | Forma: ${(d.form||"").replace(/,/g,"")} | Lőtt: ${d.scored} | Kapott: ${d.conceded}`
        : `${name}: nincs adat`;
      const [homeName, awayName] = (m.match || "").split(" vs ");
      standingsStr = `\n  Tabella/Forma: ${fmt(m.homeStandings, homeName)} | ${fmt(m.awayStandings, awayName)}`;
    }
    const base = `- ${m.sport} | ${m.match} | Kezdés: ${m.commence}\n  Valós odds: ${oddsStr}${standingsStr}`;
    const pe = poissonEdge.get(m.match);
    if (!pe) return base; // nincs Poisson adat → nem szűrjük, de nem annotáljuk
    const valueStr = pe.valueMarkets.length
      ? `\n  ✅ VALUE PIACOK (Poisson +5%+ edge): ${pe.valueMarkets.map(mk => `${mk.name} (modell: ${mk.modelProb}%, implikált: ${mk.impliedProb}%, edge: +${mk.edge}%)`).join(" | ")}`
      : `\n  ℹ️ Poisson: nincs +5%+ edge-ű piac (λH=${pe.lambdaHome} λA=${pe.lambdaAway} | legjobb edge: ${pe.markets.length ? Math.max(...pe.markets.map(mk => mk.edge)) + '%' : 'n/a'}) – tippelhető, ha a web keresés alapján megalapozott`;
    return base + valueStr;
  }).join("\n");

  const skipNote = alreadyTipped.length
    ? `\nEZEKRE A MECCSEKRE MÁR VAN TIPP – NE szerepeljen sem SINGLE tippként, sem KOMBI LÁBKÉNT: ${alreadyTipped.join("; ")}\n`
    : "";

  const hasAnyPoisson = poissonEdge.size > 0;
  const poissonInstruction = hasAnyPoisson
    ? `\n⚡ POISSON VALUE JELZÉS (ajánlás, nem tiltás): A meccsek mellett jelöltük, melyik piacokon mutat a Poisson-modell +5%+ edge-et (✅ VALUE PIACOK). Ezeket részesítsd előnyben. A ℹ️ jelölésű meccseken a modell nem talált value-t, de ezek is tippelhetők, ha a web keresés alapján megalapozottak. A kért tippszámot ettől függetlenül teljesítsd.\n`
    : "";

  const prompt = `Te egy profi labdarúgás-fogadási elemző vagy. Használj web keresést az aktuális formához, sérülésekhez és keretinformációkhoz az alábbi közelgő foci meccsekre (a következő ~36 óra).
${poissonInstruction}
Mai meccsek (valós bookmaker oddsokkal):
${matchText}
${skipNote}
NYELV – MINDEN MEZŐT MAGYARUL ADJ MEG:
- Nemzeti csapatneveknél használd a magyar nevet: pl. Norway → Norvégia, Denmark → Dánia, Austria → Ausztria, Germany → Németország, France → Franciaország, Portugal → Portugália, Spain → Spanyolország, England → Anglia, Scotland → Skócia, Netherlands → Hollandia stb.
- Klubcsapatneveknél maradj az eredeti névnél (pl. "Bayer Leverkusen", "Manchester City") – ezeknek nincs magyar nevük.
- A "market" és "pick" mezőket MINDIG magyarul add meg:
  * "Over 2.5" → "Több mint 2,5 gól" | "Under 2.5" → "Kevesebb mint 2,5 gól"
  * "Over 1.5" → "Több mint 1,5 gól" | "Under 1.5" → "Kevesebb mint 1,5 gól"
  * "Over 3.5" → "Több mint 3,5 gól" | "Under 3.5" → "Kevesebb mint 3,5 gól"
  * "BTTS Yes" / "BTTS Igen" → "Mindkét csapat betalál"
  * "BTTS No" / "BTTS Nem" → "Nem talál be mindkét csapat"
  * "1X2" marad "1X2"
  * "Asian Handicap" → "Ázsiai hendikep"
  * "Handicap" → "Hendikep"
  * "Draw No Bet" → "Döntetlen esetén visszajár"
  * "Home Win" → "Hazai győzelem" | "Away Win" → "Vendég győzelem" | "Draw" → "Döntetlen"
- A "note" indoklást természetesen magyarul írd.

KÉT dolgot adj – MINDKETTŐ KÖTELEZŐ:

1) "tippek": 6-8 ERŐS single tipp (két platform számára – minimum 6, ha van elég meccs!).
   - MECCSENKÉNT LEGFELJEBB 1 single tipp – a legerősebb piacot válaszd az adott meccsre.
   - CSAK legalább ${MIN_SINGLE_ODDS} oddsú single tippet adj – az ennél alacsonyabb oddsú kimenetet NE tedd single tippnek (a nagyon alacsony oddsúak a kombi lábak közé valók).
   - Lehetőleg KÜLÖNBÖZŐ meccsekről legyenek – minél több meccs, annál jobb.
   - PIACVÁLTOZATOSSÁG: ne csak győzelmet adj! Választhatsz: Over 2.5 / Under 2.5, BTTS (mindkét csapat szerez gólt), ázsiai hendikep (-0.5, -1), 1X2. A legértékesebb piacot válaszd az adott meccsre.

2) "kombi_labak": 4-8 BIZTONSÁGOS, alacsony kockázatú láb kombi szelvényekhez.
   - MINDEGYIK láb MÁS meccsről legyen – használj annyi különböző meccset, amennyi elérhető (legalább 2, hogy összeálljon egy kötés; ha van elég meccs, adj 6-8 lábat, hogy több, NEM átfedő kötés is kijöjjön).
   - Ezek külön-külön NEM elég értékesek single tippnek, de kombinálva értékes össz oddsot adnak.
   - Magas valószínűségű kimenetelek: erős favorit győzelme, Over 1.5, Under 4.5, hendikep -1 / -1.5 nagy favoritnál stb.
   - PIACVÁLTOZATOSSÁG: kombi lábak lehetnek Over 1.5, BTTS, hendikep – ne csak győzelmek!
   - KÖTELEZŐ ODDS SZABÁLYOK – ezeket a rendszer szerver oldalon is ellenőrzi:
     * Egy láb odds: MINIMUM 1.20, MAXIMUM 1.60 – ezen kívüli lábak automatikusan kiszűrődnek!
     * 2 lábas kombi össz odds: MINIMUM 2.00
     * 3 lábas kombi össz odds: MINIMUM 2.80 – 3 × 1.26-os láb (= 2.02) NEM FOGADHATÓ EL!
     * 4+ lábas kombi össz odds: MINIMUM 3.50
   - Ha egy kombi nem érné el a minimumot, válassz magasabb oddsú lábakat vagy ne generáld!

KÖZÖS szabályok:
- Az "odds" mezőbe CSAK a fent megadott valós bookmaker oddsok egyikét írd (a megfelelő piac/kimenet oddsát).
- A "market" és "pick" pontosan egyezzen egy valós piaccal/kimenettel; a csapatnév a fent megadott formában szerepeljen.
- Rövid (1-2 mondat) magyar indoklás valós adatok alapján (csak a "tippek"-hez kell note).

Válaszolj KIZÁRÓLAG egy JSON OBJEKTUMMAL, semmi más szöveg nélkül:
{"tippek":[{"match":"...","sport":"soccer","sportLabel":"⚽ Premier League","commence":"07.05 20:00","market":"Over 2.5","pick":"Over 2.5","odds":1.85,"note":"..."},{"match":"...","sport":"soccer","sportLabel":"⚽ La Liga","commence":"07.05 21:00","market":"BTTS","pick":"Igen","odds":1.78,"note":"..."}],"kombi_labak":[{"match":"...","sportLabel":"⚽ Bundesliga","commence":"07.05 20:00","market":"Over 1.5","pick":"Over 1.5","odds":1.28},{"match":"...","sportLabel":"⚽ Serie A","commence":"07.05 20:00","market":"1X2","pick":"Csapat A","odds":1.35}]}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 16000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await r.json();
    if (data.error) { console.error("AI API hiba:", JSON.stringify(data.error)); return { singles: [], comboLegs: [] }; }
    const text = (data.content?.filter(b => b.type === "text").map(b => b.text) || []).join("\n");
    if (!text.trim()) { console.log("AI: üres szöveges válasz. stop_reason:", data.stop_reason); return { singles: [], comboLegs: [] }; }

    // JSON kinyerés: 1) ```json...``` blokk, 2) nyers {} blokk
    let jsonStr = null;
    const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) {
      jsonStr = codeBlock[1].trim();
    } else {
      // Legelső { és legutolsó } közötti rész
      const first = text.indexOf("{");
      const last  = text.lastIndexOf("}");
      if (first !== -1 && last > first) jsonStr = text.slice(first, last + 1);
    }
    if (!jsonStr) {
      console.log("AI: nem sikerült JSON-t kinyerni. Válasz eleje:\n" + text.slice(0, 500));
      return { singles: [], comboLegs: [] };
    }
    let obj;
    try { obj = JSON.parse(jsonStr); } catch(e) {
      console.log("AI: JSON parse hiba –", e.message, "\nPróbált JSON eleje:\n" + jsonStr.slice(0, 400));
      return { singles: [], comboLegs: [] };
    }
    // A valós kezdési idő a meccslistából (odds API), nem az AI adatából
    const realCommence = name => findMatchEntry(matchList, name)?.commence || null;
    // Market mező automatikus kitöltése ha az AI kihagyta
    function inferMarket(pick, market) {
      if (market) return market;
      const p = (pick || "").toLowerCase();
      if (p.includes("over")) return "Over/Under";
      if (p.includes("under")) return "Over/Under";
      if (p === "igen" || p === "yes" || p.includes("btts")) return "BTTS";
      if (p === "nem" || p === "no") return "BTTS";
      return "1X2";
    }
    function fixPick(pick, market) {
      // BTTS tippnél a pick legyen "Igen" vagy "Nem"
      if (market === "BTTS" && !["igen","nem","yes","no"].includes((pick||"").toLowerCase())) return "Igen";
      return pick;
    }

    const singlesAll = (Array.isArray(obj.tippek) ? obj.tippek : []).map(t => {
      const market = inferMarket(t.pick, t.market);
      const pick   = fixPick(t.pick, market);
      return {
        id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: "ai", sport: t.sport, sportLabel: t.sportLabel,
        match: t.match, commence: realCommence(t.match) || t.commence || null,
        market, pick, odds: t.odds,
        live: false, note: t.note,
        poisson: (() => { const e = findMatchEntry(matchList, t.match);
                          return e ? poissonForTip(poissonEdge.get(e.match), market, pick, e.match) : null; })(),
        approved: false, sent: false,
        addedAt: nowHu(), result: "pending"
      };
    });
    // Backstop: minimum odds szűrő + meccsenként legfeljebb 1 single (az AI a legerősebbet teszi előre)
    const seenMatch = new Set();
    const singles = singlesAll
      .filter(t => (parseFloat(t.odds) || 0) >= MIN_SINGLE_ODDS)
      .filter(t => { if (seenMatch.has(t.match)) return false; seenMatch.add(t.match); return true; });
    const comboLegs = (Array.isArray(obj.kombi_labak) ? obj.kombi_labak : []).map(l => ({
      match: l.match, sportLabel: l.sportLabel || "⚽",
      market: inferMarket(l.pick, l.market), pick: l.pick,
      odds: parseFloat(l.odds) || 0, commence: l.commence || null
    })).filter(l => {
      if (!l.match || !l.market || !l.pick || l.odds <= 1) return false;
      // Hiányos meccs név kiszűrése
      const hasVs = /\svs\.?\s|\s@\s/i.test(l.match);
      if (!hasVs) { console.log(`Kombi láb kiszűrve (hiányos meccs név): "${l.match}"`); return false; }
      // Odds limit: kombi lábnak maximum 1.60 és minimum 1.20 odds
      if (l.odds > 1.60) { console.log(`Kombi láb kiszűrve (odds > 1.60): "${l.match}" @ ${l.odds}`); return false; }
      if (l.odds < 1.20) { console.log(`Kombi láb kiszűrve (odds < 1.20): "${l.match}" @ ${l.odds}`); return false; }
      return true;
    });
    // Ingyenes tipp nincs – az admin manuálisan tesz free-vé bármely single tippet
    return { singles, comboLegs };
  } catch (e) { console.error("AI tipp hiba:", e.message); return { singles: [], comboLegs: [] }; }
}

function comboHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }
// Egy kombi láb-halmaz kulcsa (sorrendtől független) – ez alapján dedupolunk.
function comboKey(c) { return (c.legs || []).map(l => `${l.match}|${l.market}|${l.pick}`).sort().join("__"); }
// ── Kombi tippek (csak az izgalom kedvéért) ───────────────
// Az AI biztonságos lábaiból NEM ÁTFEDŐ (diszjunkt) 2-3 lábas kötéseket állít össze:
// két kombi SOSE osztozik lábon (különben korreláltak lennének – ha az egyik veszít,
// a másik sem nyerhetne). Minden láb önállóan, a meccs eredménye alapján dől el.
function buildCombos(legs, matchList = []) {
  // A valós kezdési idő a meccslistából (odds API), nem az AI adatából – laza névpárosítással.
  const realCommence = name => findMatchEntry(matchList, name)?.commence || null;
  const byMatch = {};
  for (const l of legs) {
    if (!l.match || !l.odds) continue;
    if (!byMatch[l.match] || l.odds < byMatch[l.match].odds) byMatch[l.match] = l;   // meccsenként a legbiztosabb
  }
  const pool = Object.values(byMatch).sort((a, b) => a.odds - b.odds);   // legbiztosabb elöl

  // A poolt diszjunkt darabokra bontjuk (2-3 láb/darab), egy-1-leftover nélkül.
  const chunks = [];
  let i = 0, remaining = pool.length;
  while (remaining >= 2) {
    const size = remaining === 4 ? 2 : (remaining >= 3 ? 3 : 2);   // 4 → 2+2 (ne maradjon 1 árván)
    chunks.push(pool.slice(i, i + size));
    i += size; remaining -= size;
    if (chunks.length >= 3) break;   // legfeljebb 3 kombi egy futásból
  }

  const mk = items => {
    const n = items.length;
    const legsArr = items.map(l => ({
      match: l.match, sportLabel: l.sportLabel, market: l.market,
      pick: l.pick, odds: l.odds, commence: realCommence(l.match) || l.commence || null, result: null
    }));
    const odds = parseFloat(legsArr.reduce((p, l) => p * l.odds, 1).toFixed(2));
    const id   = "combo-" + n + "-" + comboHash(comboKey({ legs: legsArr }));
    return {
      id, type: "combo", legN: n, legs: legsArr, odds, comboPayout: null,
      note: `${n} lábas kötés`,
      approved: false, sent: false,
      addedAt: nowHu(), result: "pending"
    };
  };
  return chunks.map(mk);
}

// Régi tippeknek nincs approved mezőjük → azokat jóváhagyottnak tekintjük (visszafelé kompatibilitás).
const isApproved = t => t.approved !== false;

// ── Fő frissítő ───────────────────────────────────────────
async function fetchAndProcess(fromTs = null, toTs = null) {
  const now   = new Date();
  // Időablak: ha a frontend küldött fromTs/toTs-t, azt használjuk; egyébként a default ±24h
  const windowFrom = fromTs ? new Date(fromTs) : now;
  const windowTo   = toTs   ? new Date(toTs)   : new Date(now.getTime() + WINDOW_HOURS * 3600000);
  const isCustomWindow = !!(fromTs || toTs);
  console.log(`Elemzés indul: ${new Date().toLocaleString("hu-HU", { timeZone: "Europe/Budapest" })}${isCustomWindow ? ` | Ablak: ${windowFrom.toISOString()} – ${windowTo.toISOString()}` : ""}`);

  // Minden MÉG LE NEM ZÁRT (pending) single tipp meccse – dátumtól függetlenül.
  // Így egy előre (pl. tegnap) felvett, még el nem kezdődött meccsre nem ad újabb tippet.
  const tippedMatches = new Set(
    history.filter(t => t.type === "ai" && (!t.result || t.result === "pending")).map(t => t.match)
  );

  const matchList = [];
  let scannedLeagues = 0, oddsCalls = 0;
  for (const [sportKey, meta] of Object.entries(SPORT_MAP)) {
    try {
      // 1) INGYENES esemény-lekérdezés (/events = 0 kredit): van-e meccs az ablakban?
      const er = await fetch(`https://api.the-odds-api.com/v4/sports/${sportKey}/events?apiKey=${ODDS_API_KEY}&dateFormat=iso`);
      scannedLeagues++;
      if (!er.ok) continue;
      const events = await er.json();
      const hasUpcoming = (Array.isArray(events) ? events : []).some(e => {
        const t = new Date(e.commence_time);
        return t >= windowFrom && t <= windowTo;
      });
      if (!hasUpcoming) continue;   // nincs közelgő meccs → NEM kérünk (drága) oddsot

      // 2) Csak most kérünk oddsot (3 kredit/liga), mert van közelgő meccs
      const url   = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h,totals,spreads&oddsFormat=decimal&dateFormat=iso`;
      const r     = await fetch(url);
      oddsCalls++;
      if (!r.ok) continue;
      const games = await r.json();
      for (const game of games) {
        const t = new Date(game.commence_time);
        if (t < windowFrom || t > windowTo) continue;
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
              if (o.name !== "Over" && o.name !== "Under") continue;
              const key = `${o.name} ${o.point}`;
              if (!best[key] || o.price > best[key].odds)
                best[key] = { market: key, name: key, odds: parseFloat(o.price.toFixed(2)), bookmaker: bm.title };
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
  console.log(`Ligák átnézve (ingyenes): ${scannedLeagues} · odds-hívás (fizetős, ~3 kredit/liga): ${oddsCalls} · feldolgozható meccs: ${matchList.length}`);

  // Poisson value filter: API-Football gólstatisztikák → edge számítás
  const poissonEdge = await computePoissonEdge(matchList);

  // Standings gazdagítás (football-data.org, ha elérhető)
  const enrichedList = await Promise.all(matchList.map(m => enrichMatchWithStandings(m)));
  const { singles, comboLegs } = await fetchAiTips(enrichedList, [...tippedMatches], poissonEdge);

  // Backstop: a már ma tippelt meccsekre ne kerüljön újabb SINGLE (a prompt mellett is szűrünk)
  const newAiTips = singles.filter(t => !tippedMatches.has(t.match));

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
  // Backstop: ha egy kombi láb meccse már single tippként szerepel (ma, pending), kiszűrjük
  const filteredComboLegs = comboLegs.filter(l => !tippedMatches.has(l.match));
  // Kombi tippek validálása: AI oddsok vs valódi Odds API oddsok
  // Ha az AI odds > 10%-kal alacsonyabb a valódinál → kizárjuk (AI kitalált oddsot adott)
  function getRealOdds(legMatch, legMarket, legPick, matchList) {
    const entry = findMatchEntry(matchList, legMatch);
    if (!entry) return null;
    const lm = (legMarket || "").toLowerCase();
    const lp = (legPick  || "").toLowerCase();
    // A pick csapatneve (hendikepnél a szám nélkül) – magyar országnevet is kezel
    const pickTeam = normTeam(String(legPick || "").replace(/[-+]?[\d.]+$/, "").trim());
    const sameTeam = name => nameSim(pickTeam, normTeam(String(name || "").replace(/[-+]?[\d.]+$/, "").trim()));
    for (const o of (entry.odds || [])) {
      const om = (o.market || "").toLowerCase();
      // 1X2 egyezés: market "1x2" és a csapatnév egyezik
      if (lm.includes("1x2") && om.includes("1x2") && sameTeam(o.name)) return o.odds;
      // Over/Under egyezés
      if ((lm.includes("over") || lm.includes("under")) && om === lm) return o.odds;
      // Hendikep egyezés (a vonalnak is egyeznie kell)
      if (lm.includes("hendikep") && om.includes("hendikep") && sameTeam(o.name) &&
          (String(o.name).match(/[-+]?[\d.]+$/) || [""])[0].replace("+", "") === (lp.match(/[-+]?[\d.]+$/) || [""])[0].replace("+", "")) return o.odds;
      // BTTS
      if (lm.includes("btts") && om.includes("btts")) return o.odds;
    }
    return null;
  }

  const MAX_ODDS_DIFF = 0.10; // 10% tolerancia
  const validatedComboLegs = filteredComboLegs.filter(l => {
    const realOdds = getRealOdds(l.match, l.market, l.pick, matchList);
    if (!realOdds) return true; // ha nem találjuk a valódi oddsot, megtartjuk
    const aiOdds  = parseFloat(l.odds) || 0;
    if (aiOdds < realOdds * (1 - MAX_ODDS_DIFF)) {
      console.log(`[kombi] Láb kiszűrve (AI odds kitalált): ${l.match} | AI: ${aiOdds} vs valódi: ${realOdds}`);
      return false;
    }
    return true;
  });

  const freshCombos = buildCombos(validatedComboLegs, matchList)
    .filter(c => !existingKeys.has(comboKey(c)))
    .filter(c => {
      const legs = c.legs || [];
      const totalOdds = legs.reduce((p, l) => p * parseFloat(l.odds || 1), 1);
      // Minimális össz odds lábak számától függően
      const minTotal = legs.length <= 2 ? 2.00 : legs.length === 3 ? 2.80 : 3.50;
      if (totalOdds < minTotal) {
        console.log(`Kombi kiszűrve (össz odds ${totalOdds.toFixed(2)} < ${minTotal} [${legs.length} láb]): ${legs.map(l=>l.match).join(", ")}`);
        return false;
      }
      return true;
    });
  if (freshCombos.length) { history = [...freshCombos, ...history]; saveHistory(); }
  comboTips = history.filter(t => t.type === "combo" && (!t.result || t.result === "pending"));

  freeTips = history.filter(t => t.type === "free" && (!t.result || t.result === "pending"));

  // Státusz-értesítés Telegramra (a tippek TARTALMA NEM megy ki – az csak jóváhagyás után,
  // a "📤 Jóváhagyottak küldése" gombbal). Ez csak egy heads-up, hogy lefutott a lekérdezés.
  const total = fresh.length + freshCombos.length;
  const extraSlip = freshCombos.find(c => c.note && c.note.includes("Extra"));
  if (extraSlip) console.log(`Extra szelvény mentve: ${(extraSlip.legs||[]).length} láb, össz odds ${extraSlip.odds}`);
  else if (freshCombos.length === 0) console.log("Extra szelvény eredmény: NEM GENERÁLT");
  console.log(`Frissítve – ${fresh.length} új AI tipp, ${freshCombos.length} új kombi (jóváhagyásra várnak)`);
}

// ── football-data.org: 90 perces (rendes idejű) eredmény ──
// A fogadások a rendes játékidőre dőlnek el (90' + hosszabbítás[stoppage], de
// hosszabbítás/tizenegyes nélkül). Az odds API a hosszabbítással együtti végeredményt
// adja, ami kieséses meccseknél hibás. A football-data.org score.regularTime a 90 perces
// eredmény – ha be van állítva a FOOTBALLDATA_TOKEN, ezt használjuk a kiértékeléshez.
// Válogatottak: az AI magyarul írja a nevüket ("Franciaország"), az odds/eredmény API angolul
// ("France"). A párosításhoz mindkét oldalt ugyanarra az angol névre hozzuk (egész névre illesztve,
// ékezet és írásjel nélkül). Az angol változatokat is egységesítjük (Türkiye/Turkey, Czechia…).
const COUNTRY_ALIASES = {
  "magyarorszag": "hungary", "franciaorszag": "france", "nemetorszag": "germany", "olaszorszag": "italy",
  "spanyolorszag": "spain", "portugalia": "portugal", "anglia": "england", "skocia": "scotland",
  "eszak irorszag": "northern ireland", "irorszag": "ireland", "republic of ireland": "ireland",
  "hollandia": "netherlands", "svajc": "switzerland", "ausztria": "austria",
  "csehorszag": "czechia", "czech republic": "czechia", "szlovakia": "slovakia", "lengyelorszag": "poland",
  "horvatorszag": "croatia", "szerbia": "serbia", "szlovenia": "slovenia",
  "bosznia hercegovina": "bosnia and herzegovina", "bosnia herzegovina": "bosnia and herzegovina",
  "eszak macedonia": "north macedonia", "macedonia": "north macedonia", "albania": "albania", "koszovo": "kosovo",
  "gorogorszag": "greece", "torokorszag": "turkey", "turkiye": "turkey", "romania": "romania",
  "bulgaria": "bulgaria", "ukrajna": "ukraine", "feheroroszorszag": "belarus", "oroszorszag": "russia",
  "gruzia": "georgia", "ormenyorszag": "armenia", "azerbajdzsan": "azerbaijan",
  "kazahsztan": "kazakhstan", "izland": "iceland", "norvegia": "norway", "svedorszag": "sweden",
  "dania": "denmark", "finnorszag": "finland", "esztorszag": "estonia", "lettorszag": "latvia",
  "litvania": "lithuania", "ciprus": "cyprus", "luxemburg": "luxembourg", "izrael": "israel",
  "feroer szigetek": "faroe islands", "brazilia": "brazil", "kolumbia": "colombia", "mexiko": "mexico",
  "egyesult allamok": "usa", "united states": "usa", "kanada": "canada", "japan": "japan",
  "del korea": "south korea", "korea republic": "south korea", "marokko": "morocco", "szenegal": "senegal",
  "egyiptom": "egypt", "ausztralia": "australia", "tunezia": "tunisia", "algeria": "algeria",
  "elefantcsontpart": "ivory coast", "cote d ivoire": "ivory coast", "kamerun": "cameroon",
};
function normTeam(s) {
  let t = (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const key = t.replace(/[^a-z0-9]+/g, " ").trim();
  if (COUNTRY_ALIASES[key]) t = COUNTRY_ALIASES[key];
  return t
    .replace(/\b(fc|cf|sc|afc|cd|ac|ss|ssc|as|rc|fk|sk|club|deportivo|united|city)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}
// A meccslistából megkeresi az AI által írt meccsnévhez tartozó bejegyzést (pontos vagy laza
// névpárosítással – fordított sorrendet és magyar országneveket is kezel).
function findMatchEntry(matchList, name) {
  const exact = matchList.find(m => m.match === name);
  if (exact) return exact;
  const parts = String(name || "").split(/\s+vs\.?\s+/i);
  if (parts.length !== 2) return null;
  const nh = normTeam(parts[0]), na = normTeam(parts[1]);
  return matchList.find(x => {
    const p = String(x.match).split(/\s+vs\.?\s+/i);
    if (p.length !== 2) return false;
    const h = normTeam(p[0]), a = normTeam(p[1]);
    return (nameSim(nh, h) && nameSim(na, a)) || (nameSim(nh, a) && nameSim(na, h));
  }) || null;
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
  const duration = s.duration || "REGULAR";
  const reg = pick(s.regularTime);
  if (reg) return reg;                                       // regularTime mindig helyes
  if (duration === "EXTRA_TIME" || duration === "PENALTY_SHOOTOUT") {
    // Hosszabbítás/büntetők esetén fullTime ≠ 90 perc → NE használjuk visszaesésként
    console.log(`    ⚠️  KO-meccs (${duration}), de nincs regularTime adat – kiértékelés halasztva: ${m.homeTeam?.shortName || ""} vs ${m.awayTeam?.shortName || ""}`);
    return null;
  }
  return pick(s.fullTime);                                   // REGULAR meccsnél fullTime = 90 perc
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
      const dur = m.score?.duration || "REGULAR";
      if (sc && sc.home != null) {
        if (dur === "EXTRA_TIME" || dur === "PENALTY_SHOOTOUT") {
          console.log(`    ℹ️  KO-meccs (${dur}): 90 perces eredmény = ${sc.home}-${sc.away} (nem a végeredmény!)`);
        }
        return { home: sc.home, away: sc.away, status: dur };
      }
    }
  }
  return null;
}

// Egy piac kiértékelése a 90 perces eredmény alapján. Visszatér:
// won / lost / push / half_won / half_lost, vagy null ha nem értelmezhető.
function settleMarket(market, pick, homeTeam, awayTeam, homeScore, awayScore) {
  // Az AI magyar piac-/kimenetneveket ad ("Több mint 2,5 gól", "Mindkét csapat betalál",
  // "Hazai győzelem"), de angolul is jöhet ("Over 2.5", "BTTS") – mindkettőt felismerjük.
  const txt = x => String(x || "").toLowerCase().replace(/,/g, ".");
  const mk = txt(market), pk = txt(pick);
  // Fogadáskészítő (bet builder): manuális kiértékelés szükséges
  if (mk.includes("fogadáskészítő") || mk.includes("fogadaskeszito") || mk.includes("bet builder")) return null;
  // A pick csapatneve az AI-tól jön ("Molde"), a valós név az odds API-tól ("Molde FK") –
  // ezért laza (normalizált) névegyezést használunk, nem szigorú ===-t.
  const pickIsHome = () => nameSim(normTeam(pick), normTeam(homeTeam));
  const pickIsAway = () => nameSim(normTeam(pick), normTeam(awayTeam));
  if (mk === "1x2") {
    // Három kimenet: csapattippnél döntetlen = vereség (push nincs).
    if (/^draw$|^döntetlen$|^x$/.test(pk.trim())) return homeScore === awayScore ? "won" : "lost";
    if (/^1$|^hazai győzelem$|^home win$/.test(pk.trim()) || pickIsHome()) return homeScore > awayScore ? "won" : "lost";
    if (/^2$|^vendég győzelem$|^away win$/.test(pk.trim()) || pickIsAway()) return awayScore > homeScore ? "won" : "lost";
    return null;
  }
  if (mk.includes("btts") || mk.includes("mindkét") || pk.includes("mindkét")) {
    const both = homeScore > 0 && awayScore > 0;
    const no   = /^(nem|no)$/.test(pk.trim()) || pk.includes("nem talál") || mk.includes("nem talál") || /\bno$/.test(pk.trim());
    return (no ? !both : both) ? "won" : "lost";
  }
  // Over/Under: a kimenet (pick) dönt, mert a market lehet általános is ("Over/Under")
  const has = (...w) => w.some(x => pk.includes(x));
  const isUnder = has("under", "kevesebb mint") || (!has("over", "több mint") && (mk.includes("under") || mk.includes("kevesebb mint")));
  const isOver  = !isUnder && (has("over", "több mint") || mk.includes("over") || mk.includes("több mint"));
  if (isOver || isUnder) {
    const line = parseFloat((mk.match(/\d+(\.\d+)?/) || pk.match(/\d+(\.\d+)?/) || [0])[0]);
    const r = settleQuarter(homeScore + awayScore, line);          // ázsiai over is (2.75 stb.)
    if (isOver) return r;
    return r === "won" ? "lost" : r === "lost" ? "won"             // Under = az Over ellentettje
         : r === "half_won" ? "half_lost" : r === "half_lost" ? "half_won" : r;
  }
  if (mk.includes("hendikep") || mk.includes("handicap")) {
    const lineMatch = (pick || "").match(/-?\+?[\d.]+$/);
    if (!lineMatch) return null;
    const h      = parseFloat(lineMatch[0].replace("+", ""));      // pl. +0.75 / -1.5
    const team   = (pick || "").replace(/\s*[-+]?[\d.]+$/, "").trim();  // a csapatnév a hendikep előtt (0-s vonalnál előjel nélkül)
    const isHome = nameSim(normTeam(team), normTeam(homeTeam));
    const d      = isHome ? homeScore - awayScore : awayScore - homeScore;
    return settleQuarter(d, -h);
  }
  return null;
}

// ── Eredményjelölés ───────────────────────────────────────
async function checkResults() {
  // AI single tippek: pending vagy nem manual
  const pendingAi   = history.filter(t => t.type === "ai"   && (t.result === "pending" || !t.manual));
  // Free tippek: csak a valóban pending-ek
  const pendingFree = history.filter(t => t.type === "free"  && (!t.result || t.result === "pending"));
  const pendingSingles = [...pendingAi, ...pendingFree];
  // Kombik: nyitottak ÉS amelyeknek van még kitöltetlen lábuk
  const combosToCheck = history.filter(t => t.type === "combo" &&
    (!t.result || t.result === "pending" || (t.legs || []).some(l => !l.result)));
  if (!pendingSingles.length && !combosToCheck.length) return;
  console.log(`Eredmények ellenőrzése (${pendingAi.length} single, ${combosToCheck.length} kombi, ${pendingFree.length} free)...`);
  let changed = false;
  const fdCache = {};

  // 1. Befejezett meccsek 90 perces eredményének összegyűjtése (meccsnév → eredmény)
  // Csak azokat a sportokat kérdezzük le, amelyekhez ténylegesen van pending tipp → kredit takarékosság
  const allPending = [...pendingSingles, ...combosToCheck.flatMap(c => c.legs || [])];
  const neededSports = new Set(allPending.map(t => t.sportKey).filter(Boolean));
  // Ha nincs sportKey a tippeknél, fallback: összes sport
  const sportsToCheck = neededSports.size > 0 ? [...neededSports] : Object.keys(SPORT_MAP);
  console.log(`  Odds API lekérés: ${sportsToCheck.length} sport (${sportsToCheck.join(", ")})`);
  const completed = {};
  for (const sportKey of sportsToCheck) {
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

  // A tippek "match" neve az AI-tól jön, a completed kulcsai az odds API-tól – ezek eltérhetnek
  // (pl. "Tromso vs Vålerenga" vs "Tromsø IL vs Vålerenga Fotball"), sőt az AI a hazai/vendég
  // sorrendet is felcserélheti ("Molde vs Aalesund" a valós "Aalesund vs Molde" helyett).
  // Ezért: pontos egyezés → normalizált egyezés → FORDÍTOTT sorrendű egyezés.
  // A kiértékelés mindig a valós (odds API-s) hazai/vendég csapatot használja, így a
  // fordított párosítás sem torzítja az eredményt.
  const completedList = Object.entries(completed);
  const findByName = name => {
    if (completed[name]) return completed[name];                     // pontos egyezés
    const parts = String(name || "").split(/\s+vs\.?\s+/i);
    if (parts.length !== 2) return null;
    const nh = normTeam(parts[0]), na = normTeam(parts[1]);
    for (const [, g] of completedList) {                             // normalizált egyezés
      if (nameSim(nh, normTeam(g.home_team)) && nameSim(na, normTeam(g.away_team))) return g;
    }
    for (const [, g] of completedList) {                             // fordított hazai/vendég
      if (nameSim(nh, normTeam(g.away_team)) && nameSim(na, normTeam(g.home_team))) {
        console.log(`    ⇄ Fordított névsorrend: "${name}" → ${g.home_team} vs ${g.away_team}`);
        return g;
      }
    }
    return null;
  };
  const findGame = tip => findByName(tip.match) || Object.values(completed).find(g => g.id === tip.matchId);

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
    history  = history.map(t => t.id === tip.id ? { ...t, ...patch } : t);
    aiTips   = aiTips.map(t => t.id === tip.id ? { ...t, ...patch } : t);
    freeTips = freeTips.map(t => t.id === tip.id ? { ...t, ...patch } : t);
    changed = true;
  }

  // 3. Kombik – MINDEN láb önállóan a meccs eredménye alapján (laza névpárosítással, lásd fent).
  // KORAI VESZTES: ha akár EGY láb már vesztett, a kombi matematikailag nem nyerhet → azonnal
  // "lost" (bekerül a statisztikába), a hátralévő lábakat pedig a későbbi futások töltik ki.
  for (const combo of combosToCheck) {
    const legGames = combo.legs.map(leg => findByName(leg.match));
    const legResFresh = [];  // csak az aktuális futás fresh eredményei
    const legRes = combo.legs.map((leg, i) => {
      const g = legGames[i];
      // Ha a meccs kezdési ideje még nem jött el (>0 óra van hátra), ne értékeljük ki
      if (leg.commence) {
        const commenceHu = leg.commence.replace(/^(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})$/, "2026-$1-$2T$3:$4:00");
        const hoursUntil = (new Date(commenceHu) - Date.now()) / 3600000;
        if (hoursUntil > 0.5) {
          console.log(`    Láb kihagyva (jövőbeli, ${hoursUntil.toFixed(1)}h): ${leg.match}`);
          legResFresh.push(null);
          return null;  // jövőbeli meccsnek nem lehet érvényes eredménye
        }
      }
      const fresh = g ? settleMarket(leg.market, leg.pick, g.home_team, g.away_team, g.homeScore, g.awayScore) : null;
      const res = fresh || leg.result || null;
      if (res) console.log(`    Láb eredmény: ${leg.match} → ${res} (fresh:${fresh}, g:${!!g}, commence:${leg.commence})`);
      legResFresh.push(fresh);  // aktuális evaluáció eredménye
      return res;
    });
    const legs      = combo.legs.map((l, i) => ({ ...l, result: legRes[i] }));
    const legsFilled = JSON.stringify(legs) !== JSON.stringify(combo.legs);
    // Csak akkor lost, ha az aktuális futásban megtalált meccset értékeltük ki vesztesnek
    const anyLost   = legRes.some((r, i) => r === "lost" && legGames[i] !== null);
    const allKnown  = legRes.every(r => !!r);

    if (anyLost) {
      // A kombi bukott – akkor is, ha más lábak még nyitottak.
      const patch = { result: "lost", comboPayout: 0, legs, settledAt: combo.settledAt || nowHu() };
      if (combo.result !== "lost" || legsFilled) {
        history   = history.map(t => t.id === combo.id ? { ...t, ...patch } : t);
        comboTips = comboTips.map(t => t.id === combo.id ? { ...t, ...patch } : t);
        changed = true;
        const open = legs.filter(l => !l.result).length;
        if (combo.result !== "lost")
          console.log(`  KOMBI (${combo.legN} lábas) → lost (vesztes láb${open ? `, ${open} láb még nyitott` : ""})`);
      }
      continue;
    }

    if (!allKnown) {
      const open = combo.legs.filter((l, i) => !legRes[i])
        .map((l, i) => `${l.match}${legGames[combo.legs.indexOf(l)] ? " (piac nem értékelhető: " + l.market + "/" + l.pick + ")" : " (meccs még nincs lezárva)"}`);
      if (legsFilled) {   // részeredmények mentése (megjelenítéshez)
        history   = history.map(t => t.id === combo.id ? { ...t, legs } : t);
        comboTips = comboTips.map(t => t.id === combo.id ? { ...t, legs } : t);
        changed = true;
      }
      console.log(`  KOMBI (${combo.legN} lábas) – még nyitott: ${open.join("; ")}`);
      continue;
    }

    // Minden láb ismert és egyik sem vesztett → tényleges kifizetés
    const mults = legRes.map((r, i) => {
      const o = parseFloat(combo.legs[i].odds) || 0;
      switch (r) {
        case "won":       return o;
        case "half_won":  return (1 + o) / 2;
        case "push":      return 1;
        case "half_lost": return 0.5;
        default:          return 0;
      }
    });
    const payout = mults.reduce((a, b) => a * b, 1);
    const result = payout > 1.0001 ? "won" : payout < 0.9999 ? "lost" : "push";
    const patch  = { result, comboPayout: parseFloat(payout.toFixed(2)), legs, settledAt: nowHu() };
    if (combo.result !== result || combo.comboPayout !== patch.comboPayout || legsFilled) {
      history   = history.map(t => t.id === combo.id ? { ...t, ...patch } : t);
      comboTips = comboTips.map(t => t.id === combo.id ? { ...t, ...patch } : t);
      changed = true;
      console.log(`  KOMBI (${combo.legN} lábas) → ${result} (x${patch.comboPayout})`);
    }
  }

  if (changed) {
    saveHistory();
    freeTips = history.filter(t => t.type === "free" && (!t.result || t.result === "pending"));
    console.log("Eredmények mentve ✓");
  }
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


// ── Lejárt előfizetések ellenőrzése ──────────────────────────
function checkExpiredSubscriptions() {
  const now = new Date();
  const expired = usersDb.all().filter(u =>
    u.plan === "pro" &&
    u.paidUntil &&
    new Date(u.paidUntil) < now &&
    !u.isAdmin
  );
  if (!expired.length) return;
  expired.forEach(u => {
    const expiredAt = new Date().toISOString();
    usersDb.update(u.id, { plan: "free", subscriptionStatus: "cancelled", cancelledAt: expiredAt });
    console.log(`Előfizetés lejárt, visszaminősítve: ${u.email} (lejárt: ${u.paidUntil})`);
    sendTelegram(`⏰ <b>Előfizetés lejárt</b>\n${String(u.email).replace(/&/g, "&amp;").replace(/</g, "&lt;")}\nLejárt: ${new Date(u.paidUntil).toLocaleDateString("hu-HU")}`).catch(() => {});
    mailer.sendSubscriptionExpired(u.email).catch(e => console.error("Email hiba:", e.message));
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) mailer.send({
      to: adminEmail,
      subject: `⏰ Előfizetés lejárt – ${u.email}`,
      text: `${u.email} előfizetése lejárt.`,
      html: `<p>A <b>${u.email}</b> felhasználó előfizetése lejárt (${u.paidUntil}).</p>`,
    }).catch(e => console.error("Admin email hiba:", e.message));
  });
  console.log(`Lejárt előfizetések: ${expired.length} felhasználó visszaminősítve.`);
}

// Indításkor azonnal lefut (startup után fogja az esetleg lejártakat kezelni)
checkExpiredSubscriptions();

// ── Napnyitó: 00:03 automatikus eredmény-ellenőrzés, 00:05 napi statisztika Telegramra
//    (magyar idő). Tipptartalom NEM megy ki automatikusan – az csak jóváhagyás után, kézzel. ──
let _lastCheckDay = "", _lastStatsDay = "";
setInterval(async () => {
  const { hour, minute } = getHungarianTime();
  const dayKey = todayHU();                       // naponta egyszer, dupla lefutás ellen
  if (hour === 0 && minute === 1 && _lastCheckDay !== dayKey) {
    checkExpiredSubscriptions();
  }
  // Heti összefoglaló: minden hétfőn 08:00-kor
  if (hour === 8 && minute === 0 && new Date().getDay() === 1) {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const weekTips = history.filter(t =>
      t.type !== "combo" && t.result && t.result !== "pending" &&
      t.settledAt && new Date(t.settledAt) >= weekAgo
    );
    if (weekTips.length) {
      const won = weekTips.filter(t => t.result === "won").length;
      const lost = weekTips.filter(t => t.result === "lost").length;
      const halfWon = weekTips.filter(t => t.result === "half_won").length;
      const halfLost = weekTips.filter(t => t.result === "half_lost").length;
      const push = weekTips.filter(t => t.result === "push").length;
      const decN = won + lost + halfWon + halfLost;
      const winRate = decN ? (((won + halfWon * 0.5) / decN) * 100).toFixed(1) : "0";
      const profit = weekTips.reduce((s, t) => {
        const o = parseFloat(t.odds) || 1;
        if (t.result === "won") return s + (o - 1);
        if (t.result === "lost") return s - 1;
        if (t.result === "half_won") return s + (o - 1) / 2;
        if (t.result === "half_lost") return s - 0.5;
        return s;
      }, 0);
      const roi = weekTips.length ? ((profit / weekTips.length) * 100).toFixed(1) : "0";
      const stats = { won, lost, push, halfWon, halfLost, profit, roi, winRate, settled: weekTips.length };
      const adminUsers = usersDb.all().filter(u => u.isAdmin && u.emailVerified !== false);
      console.log(`Heti összefoglaló e-mail: ${adminUsers.length} admin felhasználónak`);
      for (const u of adminUsers) {
        mailer.sendWeeklySummary(u.email, stats).catch(e => console.error(`Heti email hiba (${u.email}):`, e.message));
      }
    }
  }
  if (hour === 4 && minute === 30 && _lastCheckDay !== dayKey) {
    _lastCheckDay = dayKey;
    console.log("Reggeli automatikus eredmény-ellenőrzés (04:30)...");
    await checkResults();
  }
  // 05:00 – Előző napi eredmény összegző Telegramra (00:05-ös általános stats helyett)
  if (hour === 5 && minute === 0 && _lastStatsDay !== dayKey) {
    _lastStatsDay = dayKey;
    try {
      const SETTLED = ["won", "lost", "push", "half_won", "half_lost"];
      // Tegnapi dátum (Budapest)
      const yest = new Date();
      yest.setDate(yest.getDate() - 1);
      const yestStr = yest.toLocaleDateString("hu-HU", { timeZone: "Europe/Budapest",
        year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\./g,"").trim()
        .replace(/(\d{4})\s*(\d{2})\s*(\d{2})/, "$1-$2-$3");
      // Tegnapi meccsek: a commence (meccs dátuma) alapján szűrünk
      function parseSingleCommence(s) {
        const c = String(s || "").trim();
        // "09.03 20:30" vagy "09. 03. 00:30" (szóközzel)
        const m1 = c.match(/^(\d{2})\.\s*(\d{2})/);
        if (m1) return `2026-${m1[1]}-${m1[2]}`;
        const m2 = c.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
        return null;
      }
      function parseCommenceDate(t) {
        // Kombi: az UTOLSÓ láb dátuma (amikor ténylegesen lezárul)
        if (t.type === "combo" && Array.isArray(t.legs) && t.legs.length) {
          const dates = t.legs.map(l => parseSingleCommence(l.commence)).filter(Boolean).sort();
          if (dates.length) return dates[dates.length - 1];
        }
        const d = parseSingleCommence(t.commence);
        if (d) return d;
        // addedAt / settledAt fallback
        const raw = t.addedAt || t.settledAt || "";
        const s = String(raw);
        const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
        const hu = s.match(/^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
        if (hu) return `${hu[1]}-${String(hu[2]).padStart(2,"0")}-${String(hu[3]).padStart(2,"0")}`;
        return null;
      }
      const yestSettled = history.filter(t =>
        SETTLED.includes(t.result) && isApproved(t) && parseCommenceDate(t) === yestStr
      );
      if (!yestSettled.length) {
        await sendTelegram(`📊 <b>Előző nap (${yestStr})</b>\nNincs lezárt tipp.`);
      } else {
        function dayStats(tips) {
          const settled  = tips.length;
          const won      = tips.filter(t => t.result === "won").length;
          const halfWon  = tips.filter(t => t.result === "half_won").length;
          const lost     = tips.filter(t => t.result === "lost").length;
          const halfLost = tips.filter(t => t.result === "half_lost").length;
          const push     = tips.filter(t => t.result === "push").length;
          const decN     = won + lost + halfWon + halfLost;   // push nélkül
          const wr       = decN ? (((won + halfWon * 0.5) / decN) * 100).toFixed(2) : "–";
          const profit   = tips.reduce((s, t) => {
            if (t.type === "combo") {
              const p = parseFloat(t.comboPayout);
              return s + (isNaN(p) ? (t.result === "won" ? (parseFloat(t.odds)||1)-1 : -1) : p-1);
            }
            const o = parseFloat(t.odds) || 1;
            if (t.result === "won")       return s + (o - 1);
            if (t.result === "lost")      return s - 1;
            if (t.result === "half_won")  return s + (o - 1) / 2;
            if (t.result === "half_lost") return s - 0.5;
            return s;
          }, 0);
          const roi = decN ? ((profit / decN) * 100).toFixed(2) : "–";
          return { settled, won: won + halfWon, lost: lost + halfLost, push, decN, profit, wr, roi };
        }
        const all  = dayStats(yestSettled);
        const vip  = dayStats(yestSettled.filter(t => t.type !== "free"));
        const free = dayStats(yestSettled.filter(t => t.type === "free"));
        const sign = v => (v >= 0 ? "+" : "") + v.toFixed(2);
        const dateHU = yest.toLocaleDateString("hu-HU", { timeZone: "Europe/Budapest",
          year: "numeric", month: "2-digit", day: "2-digit" });
        const pushLine = all.push ? `- Visszajár: ${all.push} db\n` : "";
        const msg = `🔥 <b>Statisztika – Előző nap (${dateHU})</b>\n\n`+
          `📊 <b>Összesített</b>\n`+
          `- Kiértékelt: ${all.settled} db\n`+
          `- Nyertes: ${all.won} db\n`+
          pushLine+
          `- Találati: ${all.wr}%${all.push ? ` (push nélkül: ${all.won}/${all.decN})` : ""}\n`+
          `- Profit: ${sign(all.profit)} egység\n`+
          `- ROI: ${sign(parseFloat(all.roi))}%\n\n`+
          (vip.settled  ? `📝 <b>VIP:</b> ${vip.settled} lezárt, ${vip.won} nyert${vip.push ? `, ${vip.push} visszajár` : ""}, Profit: ${sign(vip.profit)}\n` : "")+
          (free.settled ? `🆓 <b>Free:</b> ${free.settled} lezárt, ${free.won} nyert${free.push ? `, ${free.push} visszajár` : ""}, Profit: ${sign(free.profit)}\n` : "")+
          `\n🌐 www.90perc.hu`;
        await sendTelegram(msg);
      }
    } catch(e) {
      console.error("Reggeli összegző hiba:", e.message);
    }
  }
}, 60000);

// ── API végpontok ─────────────────────────────────────────
// ÉLŐ TIPPEK – ez a termék: belépés (és fizetős módban aktív előfizetés) kell hozzá.
app.get("/api/tips", (req, res) => {
  const admin = isAdminReq(req);
  const freshUserTips = req.user ? (usersDb.findById(req.user.id) || req.user) : req.user;
  if (!admin && !auth.hasAccess(freshUserTips)) {
    return res.status(req.user ? 402 : 401).json({
      error: req.user ? "Aktív előfizetés szükséges." : "Belépés szükséges a tippek megtekintéséhez.",
      needLogin: !req.user, needSubscription: !!req.user,
      aiTips: [], comboTips: [],
      // A free tippek minden látogató számára láthatók.
      freeTips: freeTips.filter(isApproved),
    });
  }
  res.json({
    aiTips:    admin ? aiTips    : aiTips.filter(isApproved),
    comboTips: admin ? comboTips : comboTips.filter(isApproved),
    freeTips:  admin ? freeTips  : freeTips.filter(isApproved),
    admin
  });
});

// ELŐZMÉNY – a LEZÁRT tippek publikusak (ez a track record, a bizalom alapja).
// A még függő (élő) tippeket csak a jogosultak látják, különben kiszivárogna a termék.
app.get("/api/history", (req, res) => {
  if (isAdminReq(req)) return res.json(history);
  const approved = history.filter(isApproved);
  const freshUserHist = req.user ? (usersDb.findById(req.user.id) || req.user) : req.user;
  if (auth.hasAccess(freshUserHist)) return res.json(approved);
  // Track record: minden lezárt tipp látható, bejelentkezés nélkül is
  const settledOnly = history.filter(t =>
    t.result && t.result !== "pending"
  );
  res.json(settledOnly);
});

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



app.get("/api/admin/stats", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const SETTLED = ["won","lost","push","half_won","half_lost"];
  const allSettled = [...history, ...comboTips].filter(t => isApproved(t) && SETTLED.includes(t.result));
  const won       = allSettled.filter(t => t.result === "won").length;
  const lost      = allSettled.filter(t => t.result === "lost").length;
  const halfWon   = allSettled.filter(t => t.result === "half_won").length;
  const halfLost  = allSettled.filter(t => t.result === "half_lost").length;
  const push      = allSettled.filter(t => t.result === "push").length;
  const decN      = won + lost + halfWon + halfLost;
  const winRate   = decN ? (((won + halfWon * 0.5) / decN) * 100).toFixed(1) : null;
  const profit    = allSettled.reduce((sum, t) => {
    if (t.type === "combo") {
      const p = parseFloat(t.comboPayout);
      return sum + (isNaN(p) ? (t.result === "won" ? (parseFloat(t.odds)||1)-1 : -1) : p - 1);
    }
    const o = parseFloat(t.odds) || 1;
    if (t.result === "won")       return sum + (o - 1);
    if (t.result === "lost")      return sum - 1;
    if (t.result === "half_won")  return sum + (o - 1) / 2;
    if (t.result === "half_lost") return sum - 0.5;
    return sum;
  }, 0);
  const roi = allSettled.length ? ((profit / allSettled.length) * 100).toFixed(1) : null;

  // Havi bontás
  const byMonth = {};

  function tipMonth(t) {
    // Próbálja ISO formátumból: "2026-08-30T..." → "2026-08"
    const raw = t.createdAt || t.addedAt || "";
    if (!raw) return null;
    // ISO: "2026-08-..." → slice(0,7) = "2026-08" ✓
    const isoMatch = String(raw).match(/^(\d{4}-\d{2})/);
    if (isoMatch) return isoMatch[1];
    // Magyar: "30.08.2026" → "2026-08"
    const huMatch = String(raw).match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (huMatch) return `${huMatch[3]}-${huMatch[2]}`;
    return null;
  }

  allSettled.forEach(t => {
    const d = tipMonth(t);
    if (!d) return;
    if (!byMonth[d]) byMonth[d] = { settled: 0, won: 0, lost: 0, profit: 0 };
    byMonth[d].settled++;
    const isCombo = t.type === "combo";
    const cp = isCombo ? parseFloat(t.comboPayout) : NaN;
    const o = parseFloat(t.odds) || 1;
    if (t.result === "won")       { byMonth[d].won++;  byMonth[d].profit += isCombo && !isNaN(cp) ? cp - 1 : o - 1; }
    if (t.result === "half_won")  { byMonth[d].won++;  byMonth[d].profit += (o - 1) / 2; }
    if (t.result === "lost")      { byMonth[d].lost++; byMonth[d].profit -= 1; }
    if (t.result === "half_lost") { byMonth[d].lost++; byMonth[d].profit -= 0.5; }
    // push: settled-be beleszámít, de profit 0 (tét visszajár) → külön ág nem kell
  });
  const monthly = Object.entries(byMonth).sort().map(([month, s]) => ({
    month, settled: s.settled, won: s.won, lost: s.lost,
    profit: parseFloat(s.profit.toFixed(2)),
    roi: s.settled ? parseFloat(((s.profit/s.settled)*100).toFixed(1)) : 0,
    winRate: (s.won+s.lost) ? parseFloat(((s.won/(s.won+s.lost))*100).toFixed(1)) : null
  }));

  res.json({ settled: allSettled.length, won, lost, push, halfWon, halfLost,
             winRate, profit: parseFloat(profit.toFixed(2)), roi, monthly });
});

app.get("/api/public-stats", (req, res) => {
  const isFociSrv = t => /soccer|foci|⚽/i.test((t.sport || "") + " " + (t.sportLabel || ""));
  const H = history.filter(t =>
    t.type !== "combo" && t.type !== "value" &&
    isApproved(t) && isFociSrv(t) &&
    ["won","lost","push","half_won","half_lost"].includes(t.result)
  );
  const won      = H.filter(t => t.result === "won").length;
  const lost     = H.filter(t => t.result === "lost").length;
  const halfWon  = H.filter(t => t.result === "half_won").length;
  const halfLost = H.filter(t => t.result === "half_lost").length;
  const push     = H.filter(t => t.result === "push").length;
  const settled  = H.length;
  const decN     = won + lost + halfWon + halfLost;
  const winRate  = decN ? (((won + halfWon * 0.5) / decN) * 100).toFixed(1) : null;
  const profit   = H.reduce((sum, t) => {
    const o = parseFloat(t.odds) || 1;
    if (t.result === "won")       return sum + (o - 1);
    if (t.result === "lost")      return sum - 1;
    if (t.result === "half_won")  return sum + (o - 1) / 2;
    if (t.result === "half_lost") return sum - 0.5;
    return sum;  // push
  }, 0);
  const roi = settled ? ((profit / settled) * 100).toFixed(1) : null;
  res.json({ settled, won, lost, push, halfWon, halfLost, winRate, profit: parseFloat(profit.toFixed(2)), roi });
});

app.post("/api/refresh", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { fromTs, toTs } = req.body || {};
  try {
    await fetchAndProcess(fromTs || null, toTs || null);
    res.json({ ok: true, aiTips: aiTips.length });
  } catch(e) {
    console.error("[refresh] Hiba:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/history/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { result, note, comboPayout, odds, legs, pick, market } = req.body;

  // Note / odds / pick / market / legs szerkesztés
  if (note !== undefined || odds !== undefined || legs !== undefined || pick !== undefined || market !== undefined) {
    const patch = {};
    if (note   !== undefined) patch.note   = note;
    if (odds   !== undefined) patch.odds   = parseFloat(odds);
    if (pick   !== undefined) patch.pick   = pick;
    if (market !== undefined) patch.market = market;
    if (legs !== undefined) {
      patch.legs  = legs;
      patch.legN  = legs.length;
      const totalOdds = legs.reduce((p, l) => p * parseFloat(l.odds || 1), 1);
      patch.totalOdds = parseFloat(totalOdds.toFixed(2));
    }
    const upd = t => t.id === req.params.id ? { ...t, ...patch } : t;
    history = history.map(upd); latestTips = latestTips.map(upd);
    aiTips = aiTips.map(upd); comboTips = comboTips.map(upd); if (typeof freeTips !== "undefined") freeTips = freeTips.map(upd);
    saveHistory();
    console.log(`Szerkesztve: ${req.params.id}${odds ? " odds:"+odds : ""}${note !== undefined ? " note" : ""}`);
    return res.json({ ok: true });
  }

  // Eredmény kézi beállítása
  const validResults = ["won","lost","push","half_won","half_lost","pending"];
  if (!validResults.includes(result)) return res.status(400).json({ error: "Érvénytelen eredmény" });
  const patch = { result, manual: true };
  const upd = t => t.id === req.params.id ? { ...t, ...patch } : t;
  history    = history.map(upd);
  latestTips = latestTips.map(upd);
  aiTips     = aiTips.map(upd);
  comboTips  = comboTips.map(upd);
  if (typeof freeTips !== "undefined" && freeTips) freeTips = freeTips.map(upd);
  // Ha pending-re állítjuk vissza és nincs benne a comboTips-ben, visszaadjuk
  if (result === "pending") {
    const inCombo = comboTips.some(t => t.id === req.params.id);
    if (!inCombo) {
      const fromHistory = history.find(t => t.id === req.params.id);
      if (fromHistory && fromHistory.type === "combo") comboTips.push(fromHistory);
    }
  }
  saveHistory();
  console.log(`Kézi eredmény javítás: ${req.params.id} → ${result}`);
  res.json({ ok: true });
});

app.delete("/api/history", (req, res) => {
  if (!requireAdmin(req, res)) return;
  history    = [];
  latestTips = [];
  aiTips     = [];
  comboTips  = [];
  freeTips   = [];
  saveHistory();
  console.log("History törölve ✓");
  res.json({ ok: true });
});

// Egyetlen tipp/kombi törlése azonosító alapján
app.delete("/api/history/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = req.params.id;
  const before = history.length;
  history   = history.filter(t => t.id !== id);
  aiTips    = aiTips.filter(t => t.id !== id);
  comboTips = comboTips.filter(t => t.id !== id);
  freeTips  = history.filter(t => t.type === "free" && (!t.result || t.result === "pending"));
  const removed = before - history.length;
  if (removed) saveHistory();
  console.log(`Tipp törölve (${id}): ${removed} db`);
  res.json({ ok: true, removed });
});


// VIP tipp → Free tipp konverzió. A tipp NEM lesz automatikusan publikus:
// jóváhagyásra vár, amíg az admin külön jóvá nem hagyja.
app.post("/api/history/:id/make-free", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = req.params.id;
  const tip = history.find(t => t.id === id);
  if (!tip) return res.status(404).json({ ok: false, error: "Tipp nem található" });
  if (tip.type === "free")  return res.status(400).json({ ok: false, error: "Már free tipp" });
  if (tip.type === "combo") return res.status(400).json({ ok: false, error: "Kombiból nem lehet free tipp" });

  history  = history.map(t => t.id === id ? { ...t, type: "free", approved: false } : t);
  aiTips   = aiTips.filter(t => t.id !== id);
  freeTips = history.filter(t => t.type === "free" && (!t.result || t.result === "pending"));
  saveHistory();
  console.log(`[make-free] ${tip.match} átalakítva free tippé (jóváhagyásra vár)`);
  res.json({ ok: true });
});

// Free tipp kézi eredmény beállítás
app.patch("/api/free-tips/:id/result", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = req.params.id;
  const { result } = req.body || {};
  const VALID = ["won","lost","push","half_won","half_lost","pending"];
  if (!VALID.includes(result)) return res.status(400).json({ ok: false, error: "Érvénytelen eredmény" });
  const patch = { result, manual: true, settledAt: result !== "pending" ? nowHu() : undefined };
  history  = history.map(t => t.id === id ? { ...t, ...patch } : t);
  freeTips = history.filter(t => t.type === "free" && (!t.result || t.result === "pending"));
  saveHistory();
  res.json({ ok: true });
});

// Tipp jóváhagyása (ettől lesz publikus)
app.patch("/api/history/:id/approve", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = req.params.id;
  const set = t => t.id === id ? { ...t, approved: true } : t;
  history   = history.map(set);
  aiTips    = aiTips.map(set);
  comboTips = comboTips.map(set);
  freeTips  = freeTips.map(set);
  saveHistory();
  res.json({ ok: true });
});

// Jóváhagyott, még el nem küldött tippek kézi kiküldése Telegramra + e-mailben
app.post("/api/tips/send", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const singlesToSend = history.filter(t => t.type === "ai"    && isApproved(t) && !t.sent && (!t.result || t.result === "pending"));
  const combosToSend  = history.filter(t => t.type === "combo" && isApproved(t) && !t.sent && (!t.result || t.result === "pending"));
  const freesToSend   = freeTips.filter(t =>                      isApproved(t) && !t.sent && (!t.result || t.result === "pending"));

  if (!singlesToSend.length && !combosToSend.length && !freesToSend.length) {
    return res.json({ ok: true, sent: 0, message: "Nincs kiküldendő (jóváhagyott, még el nem küldött) tipp." });
  }

  // Sent jelölés minden tömbben
  const sentIds = new Set([...singlesToSend, ...combosToSend, ...freesToSend].map(t => t.id));
  const mark = t => sentIds.has(t.id) ? { ...t, sent: true } : t;
  history   = history.map(mark);
  aiTips    = aiTips.map(mark);
  comboTips = comboTips.map(mark);
  freeTips  = freeTips.map(mark);
  saveHistory();

  const total = singlesToSend.length + combosToSend.length + freesToSend.length;
  console.log(`Tippek kiküldve: ${total} (${singlesToSend.length} single, ${combosToSend.length} kombi, ${freesToSend.length} free)`);

  // ── Telegram értesítők ──────────────────────────────────────────
  const dateStr = new Date().toLocaleDateString("hu-HU");

  // VIP tippek → admin privát chat
  if (singlesToSend.length || combosToSend.length) {
    const lines = [`📤 <b>Új VIP tippek – ${dateStr}</b>\n`];
    if (singlesToSend.length) {
      lines.push("🎯 <b>SINGLE TIPPEK:</b>");
      singlesToSend.forEach(t => {
        lines.push(`• <b>${t.match}</b>\n  ${t.pick} @${t.odds} | ${t.sportLabel || "⚽"} 🕐 ${t.commence || "–"}`);
      });
    }
    if (combosToSend.length) {
      combosToSend.forEach(c => {
        const legs = (c.legs || []).map(l => `  – ${l.match} | ${l.pick} @${l.odds}`).join("\n");
        lines.push(`\n🎰 <b>KOMBI</b> (${(c.legs||[]).length} lábas, össz odds: ${c.odds})\n${legs}`);
      });
    }
    sendTelegram(lines.join("\n")).catch(e => console.error("Telegram privát hiba:", e.message));
  }

  // Free tippek → publikus csatorna
  if (freesToSend.length) {
    freesToSend.forEach(t => {
      const noteStr = t.note ? `\n\n<i>${t.note}</i>` : "";
      const msg = `🆓 <b>INGYENES TIPP</b>\n\n`+
        `<b>${t.match}</b>\n`+
        `${t.pick} @${t.odds} | 🕐 ${t.commence || "–"}`+
        noteStr+
        `\n\n🌐 <a href="https://90perc.hu">90perc.hu</a> | `+
        `📲 <a href="https://t.me/+DHhLxcVboA8yOTI0">Csatlakozz a csatornához</a>`;
      sendToChannel(msg).catch(e => console.error("Telegram csatorna hiba:", e.message));
    });
  }

  // ── E-mail értesítő az összes aktív előfizetőnek ────────────────
  const recipients = usersDb.all().filter(u =>
    !u.isAdmin && u.emailVerified !== false &&
    (u.plan === "pro" || !auth.PAID_MODE)
  );
  console.log(`Tip e-mail küldése ${recipients.length} felhasználónak...`);
  for (const u of recipients) {
    mailer.sendNewTips(u.email, singlesToSend, combosToSend, freesToSend)
      .catch(e => console.error(`Tip email hiba (${u.email}):`, e.message));
  }

  res.json({ ok: true, sent: total });
});

app.post("/api/check-results", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  checkExpiredSubscriptions();
  await checkResults();
  res.json({ ok: true });
});

app.post("/api/admin/check-expiry", (req, res) => {
  if (!requireAdmin(req, res)) return;
  checkExpiredSubscriptions();
  res.json({ ok: true });
});

app.post("/api/stats/send", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  await sendTelegram(buildStatsMsg("90perc.hu – Statisztika"));
  res.json({ ok: true });
});

// ── Mondomatutit push ─────────────────────────────────────────────────────────
// Egy tippet (single / kombi / free) átküld a mondomatutit.hu /api/receive-tip
// endpointjára. A tipp a mondomatutit admin panelén "Jóváhagyásra vár" státuszban
// jelenik meg – Tibi ott dönt, hogy publikálja-e és mikor küldi ki.
async function pushTipToMondomatutit(tip) {
  if (!MONDOMATUTIT_PASS) throw new Error("MONDOMATUTIT_ADMIN_PASSWORD nincs beállítva");

  // tip_type meghatározása a 90perc.hu belső type mezőből
  const tipType = tip.type === "combo" ? "kombi"
                : tip.type === "free"  ? "free"
                : "single";

  const commence    = tip.commence || "";
  const commenceStr = commence ? ` 🕐 ${commence}` : "";
  const mktPrefix   = (tip.market && tip.market.toLowerCase() !== "1x2")
                      ? `${tip.market}: ` : "";

  // Kombi lábak JSON-ba csomagolva
  let aiLegs = null;
  if (tip.type === "combo" && Array.isArray(tip.legs)) {
    aiLegs = JSON.stringify(tip.legs.map(l => ({
      match:    l.match    || "",
      pick:     l.pick     || "",
      odds:     l.odds     || 0,
      market:   l.market   || "1X2",
      commence: l.commence || ""
    })));
  }

  // target_date kinyerése commence stringből ("09.20 20:00" → "2026-09-20")
  let targetDate = null;
  if (commence) {
    const m = commence.match(/(\d{2})\.(\d{2})/);
    if (m) targetDate = `${new Date().getFullYear()}-${m[1]}-${m[2]}`;
  }
  if (!targetDate) targetDate = new Date().toISOString().slice(0, 10);

  // tipp_neve formázása (mondomatutit konvenció szerint)
  const tippNeve = tip.type === "combo"
    ? `[AI] Kombi – össz odds ${tip.odds}`
    : `[AI${tip.type === "free" ? " FREE" : ""}] ${tip.match} – ${mktPrefix}${tip.pick} @ ${tip.odds}${commenceStr}`;

  // ai_note összeállítása – kombikhoz a lábakat is beleírjuk,
  // mert a mondomatutit ai_tips_review.html '\nLábak:\n' szeparátorral jeleníti meg őket.
  let aiNote = tip.note || "";
  if (tip.type === "combo" && Array.isArray(tip.legs) && tip.legs.length) {
    const legsStr = tip.legs.map(l =>
      `  • ${l.match}: ${l.pick} @ ${l.odds}` + (l.commence ? ` 🕐 ${l.commence}` : "")
    ).join("\n");
    aiNote = (aiNote ? aiNote + "\n\n" : "") + `Lábak:\n${legsStr}`;
  }

  const body = {
    tipp_neve:   tippNeve,
    eredo_odds:  tip.odds,
    tip_type:    tipType,
    ai_match:    tip.match   || "",
    ai_pick:     tip.pick    || "",
    ai_market:   tip.market  || "1X2",
    ai_commence: commence,
    ai_note:     aiNote,
    ai_legs:     aiLegs,
    target_date: targetDate
  };

  const r = await fetch(`${MONDOMATUTIT_URL}/api/receive-tip`, {
    method:  "POST",
    headers: {
      "Content-Type":     "application/json",
      "X-Admin-Password": MONDOMATUTIT_PASS
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined
  });

  let data;
  try { data = await r.json(); } catch(e) { throw new Error(`HTTP ${r.status} – nem JSON válasz`); }
  if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;  // { ok: true, id: <supabase_id> }
}

// Admin endpoint: "→ Mondomatutit" gomb hívja
app.post("/api/admin/push-to-mondomatutit", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { tipId } = req.body || {};
  if (!tipId) return res.status(400).json({ error: "tipId kötelező" });

  // Megkeresés az összes in-memory tömbben
  const tip = [...history, ...freeTips, ...comboTips].find(t => t.id === tipId);
  if (!tip) return res.status(404).json({ error: "Tipp nem található (id: " + tipId + ")" });

  try {
    const result = await pushTipToMondomatutit(tip);
    console.log(`[mondomatutit ✓] ${tip.match || "kombi"} @ ${tip.odds} → id: ${result.id}`);
    res.json({ ok: true, mondomatutit_id: result.id });
  } catch (e) {
    console.error(`[mondomatutit ✗] ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── Indítás ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
// ── Admin fiók bootstrap ──────────────────────────────────
// Ha be van állítva ADMIN_EMAIL + ADMIN_PASSWORD, létrehozzuk/frissítjük az admin fiókot,
// hogy e-mail+jelszóval be tudj lépni (ez az egyetlen admin belépési mód).
(async () => {
  const email = process.env.ADMIN_EMAIL;
  if (!email || !ADMIN_PWD) return;
  const existing = usersDb.findByEmail(email);
  if (existing) {
    if (!existing.isAdmin) usersDb.update(existing.id, { isAdmin: true });
  } else {
    const r = await usersDb.create(email, ADMIN_PWD, { isAdmin: true, skipPolicy: true });
    if (r.ok) console.log(`✓ Admin fiók létrehozva: ${email}`);
    else console.warn(`⚠️  Admin fiók létrehozása sikertelen: ${r.error}`);
    if (ADMIN_PWD.length < 12) console.warn("⚠️  Az ADMIN_PASSWORD rövid – éles üzemben érdemes hosszabbra cserélni.");
  }
})();

console.log(`Regisztrált felhasználók: ${usersDb.count()} · Fizetős mód: ${auth.PAID_MODE ? "BE" : "KI (ingyenes szakasz)"}`);


// ── Globális hibakezelők ──────────────
// Elkapatlan kivétel után a folyamat állapota bizonytalan (félbemaradt írás, memóriában lévő
// tippek) – ilyenkor naplózunk és kilépünk; a Render automatikusan, tiszta állapotból újraindít.
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION – újraindítás:", err.message);
  console.error(err.stack);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("UNHANDLED REJECTION:", reason);
  // NE lépjünk ki – a szerver maradjon fent
});


app.listen(PORT, () => {
  console.log(`90perc.hu fut: http://localhost:${PORT}`);
  telegramBot.registerWebhook();
});

if (!usersDb.all().some(u => u.isAdmin) && !(process.env.ADMIN_EMAIL && ADMIN_PWD)) {
  console.warn("⚠️  Nincs admin fiók, és ADMIN_EMAIL + ADMIN_PASSWORD sincs beállítva – az admin felület így nem érhető el. Állítsd be a Renderen!");
}
// ── football-data.org: standings cache ──────────────────────────────────────
// Odds API liga-címke (SPORT_MAP label) → football-data.org competition code.
// Pontos egyezés kell: részszöveggel pl. a "2. Bundesliga" is a Bundesligát kapná.
const FD_LABEL_MAP = {
  "⚽ Premier League":        "PL",
  "⚽ Championship":          "ELC",
  "⚽ League One":           "EL1",
  "⚽ La Liga":              "PD",
  "⚽ Bundesliga":           "BL1",
  "⚽ Serie A":              "SA",
  "⚽ Ligue 1":              "FL1",
  "⚽ Eredivisie":           "DED",
  "⚽ Primeira Liga":        "PPL",
  "⚽ Török Szuperliga":     "TL",
  "⚽ Lengyel Ekstraklasa":  "PL1",
  "⚽ Brazil Serie A":       "BSA",
};

let _standingsCache = {};
const STANDINGS_TTL = 3600000;

// Csapatnév → szavak (ékezet nélkül, a "FC", "Club" stb. elhagyásával)
const TEAM_STOPWORDS = new Set(["fc","cf","afc","ac","sc","cd","ss","ssc","as","rc","fk","sk","club","de","del","the","and","1"]);
function teamTokens(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(t => t && !TEAM_STOPWORDS.has(t));
}
// Az Odds API csapatnevét ("Inter Milan") megkeresi a tabellában ("FC Internazionale Milano" / "Inter").
// A keresett név szavainak lefedettsége dönt (előtag-egyezés is jó: inter ~ internazionale,
// milan ~ milano); holtversenyben az nyer, akinek a nevéből több szó egyezik
// ("AC Milan" → Milan, nem "Internazionale Milano"). Csak egyértelmű legjobb találatot fogad el.
function findTeam(teams, oddsName) {
  const q = teamTokens(oddsName);
  if (!q.length) return null;
  const tokMatch = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));
  const score = cand => {
    const c = teamTokens(cand);
    if (!c.length) return 0;
    const recall    = q.filter(t => c.some(x => tokMatch(t, x))).length / q.length;
    const precision = c.filter(x => q.some(t => tokMatch(t, x))).length / c.length;
    return recall ? recall + 0.1 * precision : 0;
  };
  let best = null, bestScore = 0, second = 0;
  for (const t of Object.values(teams)) {
    const sc = Math.max(score(t.name), score(t.shortName));
    if (sc > bestScore) { second = bestScore; bestScore = sc; best = t; }
    else if (sc > second) second = sc;
  }
  return bestScore >= 0.5 && bestScore > second ? best : null;
}

async function fetchStandings(compCode) {
  const now = Date.now();
  if (_standingsCache[compCode] && now - _standingsCache[compCode].updatedAt < STANDINGS_TTL) {
    return _standingsCache[compCode].teams;
  }
  if (!FOOTBALLDATA_TOKEN) return null;
  try {
    const r = await fetch(`https://api.football-data.org/v4/competitions/${compCode}/standings`, {
      headers: { "X-Auth-Token": FOOTBALLDATA_TOKEN }
    });
    if (!r.ok) return null;
    const j = await r.json();
    const tableOf = type => (j.standings || []).find(s => s.type === type)?.table || [];
    const table = tableOf("TOTAL");
    const teams = {};
    for (const row of table) {
      const name = row.team?.name || "";
      teams[name] = {
        name,
        shortName: row.team?.shortName || "",
        position: row.position,
        points:   row.points,
        played:   row.playedGames,
        form:     row.form || "",
        scored:   row.goalsFor,
        conceded: row.goalsAgainst,
      };
    }
    // Liga hazai/idegenbeli gólátlaga (a hazai pálya előnyéhez a Poisson-modellben)
    const sum = (rows, f) => rows.reduce((a, x) => a + (x[f] || 0), 0);
    const homeRows = tableOf("HOME"), awayRows = tableOf("AWAY");
    let league;
    if (homeRows.length && awayRows.length && sum(homeRows, "playedGames")) {
      const games = sum(homeRows, "playedGames");
      league = { games, homeAvg: sum(homeRows, "goalsFor") / games, awayAvg: sum(awayRows, "goalsFor") / games };
    } else {
      // Nincs külön hazai/vendég tabella: az összesítettből, szokásos ~10%-os hazai előnnyel
      const games = sum(table, "playedGames") / 2;
      const perTeam = games ? sum(table, "goalsFor") / (2 * games) : 0;
      league = { games, homeAvg: perTeam * 1.1, awayAvg: perTeam * 0.9 };
    }
    const games = league.games;
    _standingsCache[compCode] = { updatedAt: now, teams, league };
    console.log(`[standings] ${compCode}: ${table.length} csapat betöltve (${games} meccs, hazai átlag ${league.homeAvg.toFixed(2)}, vendég ${league.awayAvg.toFixed(2)})`);
    return teams;
  } catch (e) {
    console.warn(`[standings] ${compCode} hiba:`, e.message);
    return null;
  }
}

// Tabella + ligaátlagok (Poisson-modellhez)
async function getLeagueStats(compCode) {
  const teams = await fetchStandings(compCode);
  return teams ? _standingsCache[compCode] : null;
}

async function enrichMatchWithStandings(match) {
  const compCode = FD_LABEL_MAP[match.sport];
  if (!compCode) return match;

  const teams = await fetchStandings(compCode);
  if (!teams) return match;

  const [homeName, awayName] = (match.match || "").split(" vs ");
  const homeData = findTeam(teams, homeName);
  const awayData = findTeam(teams, awayName);

  if (!homeData && !awayData) return match;
  return { ...match, homeStandings: homeData || null, awayStandings: awayData || null };
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

// Csak meccs lista összeállítása AI nélkül
async function fetchMatchListOnly(fromTs = null, toTs = null) {
  const now = new Date();
  // Ha explicit időablakot kap, azt használja; egyébként a default ±24h
  const windowFrom = fromTs ? new Date(fromTs) : new Date(now.getTime() + 1.5 * 3600000);
  const windowTo   = toTs   ? new Date(toTs)   : new Date(now.getTime() + WINDOW_HOURS * 3600000);
  const newList = [];
  for (const [sportKey, meta] of Object.entries(SPORT_MAP)) {
    try {
      const er = await fetch(`https://api.the-odds-api.com/v4/sports/${sportKey}/events?apiKey=${ODDS_API_KEY}&dateFormat=iso`);
      if (!er.ok) continue;
      const events = await er.json();
      const hasUpcoming = (Array.isArray(events) ? events : []).some(e => {
        const t = new Date(e.commence_time);
        return t >= windowFrom && t <= windowTo;
      });
      if (!hasUpcoming) continue;
      const r = await fetch(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h,totals,spreads&oddsFormat=decimal&dateFormat=iso`);
      if (!r.ok) continue;
      const games = await r.json();
      for (const g of (Array.isArray(games) ? games : [])) {
        const t = new Date(g.commence_time);
        if (t < windowFrom || t > windowTo) continue;
        // Normalizált odds (ugyanolyan formátum mint fetchAndProcess-ben)
        const normOdds = [];
        const validBMs = (g.bookmakers || []).filter(bm => !EXCLUDED_BM.includes(bm.key) && bm.markets?.length > 0);
        // 1X2
        const h2hBMs = validBMs.filter(bm => bm.markets.find(m => m.key === "h2h"));
        if (h2hBMs.length) {
          const names = h2hBMs[0].markets.find(m => m.key === "h2h").outcomes.map(o => o.name);
          names.forEach(name => {
            let best = 0, bestBM = "";
            for (const bm of h2hBMs) {
              const o = bm.markets.find(m => m.key === "h2h")?.outcomes?.find(x => x.name === name);
              if (o && o.price > best) { best = o.price; bestBM = bm.title; }
            }
            if (best) normOdds.push({ market: "1X2", name, odds: parseFloat(best.toFixed(2)), bookmaker: bestBM });
          });
        }
        // Over/Under totals
        const totalsBMs = validBMs.filter(bm => bm.markets.find(m => m.key === "totals"));
        if (totalsBMs.length) {
          const best = {};
          for (const bm of totalsBMs) {
            for (const o of bm.markets.find(m => m.key === "totals")?.outcomes || []) {
              if (o.name !== "Over" && o.name !== "Under") continue;
              const key = `${o.name} ${o.point}`;
              if (!best[key] || o.price > best[key].odds)
                best[key] = { market: key, name: key, odds: parseFloat(o.price.toFixed(2)), bookmaker: bm.title };
            }
          }
          normOdds.push(...Object.values(best));
        }
        // Spreads/Hendikep
        const spreadsBMs = validBMs.filter(bm => bm.markets.find(m => m.key === "spreads"));
        if (spreadsBMs.length) {
          const best = {};
          for (const bm of spreadsBMs) {
            for (const o of bm.markets.find(m => m.key === "spreads")?.outcomes || []) {
              const key = `${o.name}_${o.point}`;
              if (!best[key] || o.price > best[key].odds)
                best[key] = { market: `Hendikep ${o.point > 0 ? "+" : ""}${o.point}`, name: `${o.name} ${o.point > 0 ? "+" : ""}${o.point}`, odds: parseFloat(o.price.toFixed(2)), bookmaker: bm.title };
            }
          }
          normOdds.push(...Object.values(best));
        }
        if (!normOdds.length) continue;
        const d = new Date(g.commence_time);
        const hStr = d.toLocaleString("hu-HU", { timeZone: "Europe/Budapest", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
        newList.push({
          sport: meta.label,
          match: `${g.home_team} vs ${g.away_team}`,
          commence: hStr.replace(",", " ").replace("  ", " "),
          commence_time: g.commence_time,   // ISO – frontend formázáshoz
          odds: normOdds
        });
      }
    } catch(e) {}
  }
  console.log(`[match-list] fetchMatchListOnly kész: ${newList.length} meccs`);
  return newList;
}

// Helper: meccs lista → frontend-ready formátum (commenceHu string, odds string, Poisson badge)
function _enrichMatchesForPreview(matchArr, edgeMap) {
  return matchArr.map(m => {
    let commenceHu = m.commence || "";
    if (m.commence_time) {
      const dt = new Date(m.commence_time);
      commenceHu = dt.toLocaleString("hu-HU", {
        timeZone: "Europe/Budapest",
        month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit"
      }).replace(",", "").trim();
    }
    const oddsArr = Array.isArray(m.odds) ? m.odds : [];
    const h2h = oddsArr.filter(o => o.market === "1X2");
    const oddsStr = (h2h.length ? h2h : oddsArr.slice(0, 3))
      .map(o => `${o.name}: ${o.odds}`).join(" | ") || "–";
    const pe = edgeMap[m.match];
    const poiStr = pe
      ? (pe.hasValue
          ? ` ✅ ${(pe.valueMarkets||[]).map(v=>`${v.name}+${v.edge}%`).join(", ")}`
          : ` ⚠️ λH:${pe.lambdaHome} λA:${pe.lambdaAway}`)
      : "";
    return { ...m, commenceHu, odds: oddsStr + poiStr, commence_time: m.commence_time || "" };
  });
}

// Admin meccs előnézet – tippek.html admin panel hívja (POST /api/admin/preview-matches)
// Visszaadja az aktuális meccslistát (cache vagy friss lekérés), opcionális Poisson edge-gel.
app.post("/api/admin/preview-matches", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { fromTs, toTs } = req.body || {};
    const isCustomWindow = !!(fromTs || toTs);
    // Ha egyéni időablak van, mindig friss lekérés (ne a 24h-s cache-t szűrje)
    // Ha nincs, csak akkor frissít ha a cache régi (>30 perc)
    const cacheAge = lastMatchListTs ? (Date.now() - lastMatchListTs) / 60000 : 999;
    if (isCustomWindow || !lastMatchList.length || cacheAge > 30) {
      const newList = await fetchMatchListOnly(fromTs || null, toTs || null);
      if (newList && newList.length > 0) {
        if (!isCustomWindow) {
          // Csak a default ablakos lekérés írja felül a cache-t
          lastMatchList = newList;
          lastMatchListTs = Date.now();
          try { require("fs").writeFileSync(path.join(DATA_DIR, "last_match_list.json"), JSON.stringify(newList)); } catch(e) {}
        }
        // Egyéni ablak esetén ideiglenesen használjuk, de nem írjuk felül a cache-t
        const fresh = newList;
        // Poisson edge
        const edgeMap = {};
        try {
          const pe = await computePoissonEdge(fresh);
          for (const [matchName, data] of pe.entries()) {
            edgeMap[matchName] = { hasValue: data.hasValue, valueMarkets: data.valueMarkets, lambdaHome: data.lambdaHome, lambdaAway: data.lambdaAway };
          }
        } catch(e) { console.warn("Poisson preview hiba:", e.message); }
        const matchesForFrontend = _enrichMatchesForPreview(fresh, edgeMap);
        return res.json({ matches: matchesForFrontend, edgeMap, scanned: Object.keys(edgeMap).length, oddsHits: fresh.length, cachedAgoMin: 0, generatedAt: new Date().toISOString() });
      }
    }
    // Időszak szűrő a cache-en: frontend fromTs/toTs paramétereket küldhet
    const fromMs = fromTs ? new Date(fromTs).getTime() : Date.now() - 2 * 3600000;
    const toMs   = toTs   ? new Date(toTs).getTime()   : Date.now() + 28 * 3600000;
    const fresh = lastMatchList.filter(m => {
      // Elsősorban commence_time (ISO) alapján szűrünk
      if (m.commence_time) {
        const t = new Date(m.commence_time).getTime();
        return t >= fromMs && t <= toMs;
      }
      // Fallback: commence string parse
      if (!m.commence) return true;
      const c = String(m.commence).replace(",", " ");
      const match = c.match(/(\d{2})\.(\d{2})\.?\s+(\d{2}):(\d{2})/);
      if (!match) return true;
      const [,mm,dd,hh,min] = match;
      const d = new Date(`${new Date().getFullYear()}-${mm}-${dd}T${hh}:${min}:00+02:00`);
      return d.getTime() >= fromMs && d.getTime() <= toMs;
    });
    // Poisson edge szinkron (cache-ből – ne lassítsa a lekérést)
    const edgeMap = {};
    try {
      const pe = await computePoissonEdge(fresh);
      for (const [matchName, data] of pe.entries()) {
        edgeMap[matchName] = { hasValue: data.hasValue, valueMarkets: data.valueMarkets, lambdaHome: data.lambdaHome, lambdaAway: data.lambdaAway };
      }
    } catch(e) { console.warn("Poisson preview hiba:", e.message); }

    const matchesForFrontend = _enrichMatchesForPreview(fresh, edgeMap);
    res.json({
      matches: matchesForFrontend,
      edgeMap,
      scanned: Object.keys(edgeMap).length,
      oddsHits: fresh.length,
      cachedAgoMin: Math.round(cacheAge),
      generatedAt: new Date().toISOString()
    });
  } catch(e) {
    console.error("preview-matches hiba:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/refresh-odds-only", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const newList = await fetchMatchListOnly();
    if (newList && newList.length > 0) {
      lastMatchList = newList;
      try { require("fs").writeFileSync(path.join(DATA_DIR, "last_match_list.json"), JSON.stringify(lastMatchList)); } catch(e) {}
      console.log(`Odds frissítve (AI nélkül): ${lastMatchList.length} meccs`);
    }
    res.json({ ok: true, matches: lastMatchList.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Meccs lista lekérése (mondomatutit Tipp Manager számára)
let lastMatchList = [];
let lastMatchListTs = 0;
(() => {
  try {
    const saved = JSON.parse(require("fs").readFileSync(path.join(DATA_DIR, "last_match_list.json"), "utf8"));
    if (Array.isArray(saved)) lastMatchList = saved;
    console.log(`Meccs lista betöltve: ${lastMatchList.length} meccs`);
  } catch(e) {}
})();

// Külső fogyasztó: a mondomatutit AI generátor admin jelszóval hívja (X-Admin-Password header),
// ezért itt – és CSAK itt – a belépett admin mellett az ADMIN_PASSWORD is elfogadott.
const matchListFails = security.hitCounter(10, 15 * 60 * 1000);
function matchListAuth(req, res) {
  if (req.user?.isAdmin) return true;
  const key = req.ip || "?";
  const pwd = req.get("x-admin-password") || "";
  if (ADMIN_PWD && pwd && !matchListFails.blocked(key)) {
    const h = x => require("crypto").createHash("sha256").update(String(x)).digest();
    if (require("crypto").timingSafeEqual(h(pwd), h(ADMIN_PWD))) return true;
    matchListFails.hit(key);
  }
  res.status(403).json({ error: "Hozzáférés megtagadva." });
  return false;
}
app.get("/api/match-list", async (req, res) => {
  if (!matchListAuth(req, res)) return;
  const tippedMatches = [...new Set(history
    .filter(t => t.result === "pending" && (t.type === "ai" || t.type === "combo" || t.type === "free"))
    .flatMap(t => t.type === "combo" ? (t.legs||[]).map(l => l.match) : [t.match])
    .filter(Boolean)
  )];
  const tippedPicks = history
    .filter(t => t.result === "pending" && t.type === "ai")
    .map(t => t.pick).filter(Boolean);
  // Múltbeli meccsek kiszűrése – csak a jövőbeli meccsek (max 2 óra múltban)
  console.log(`[match-list] ${lastMatchList.length} meccs a cacheben, szűrés...`);
  const now = Date.now();
  const freshMatches = lastMatchList.filter(m => {
    if (!m.commence) return true;
    // Kezeli: "08.30 12:15" és "08.30. 12:15" (hu-HU locale trailing dot) és "08.30, 12:15"
    const c = String(m.commence).replace(",", " ");
    const match = c.match(/(\d{2})\.(\d{2})\.?\s+(\d{2}):(\d{2})/);
    if (!match) return true;
    const [,mm,dd,hh,min] = match;
    // Budapest (UTC+2) → UTC korrekció
    const year = new Date().getFullYear();
    const d = new Date(`${year}-${mm}-${dd}T${hh}:${min}:00+02:00`);
    const hoursAgo = (now - d.getTime()) / 3600000;
    return hoursAgo < 2;  // max 2 óra múltban tartunk meg
  });
  console.log(`[match-list] ${freshMatches.length} friss meccs visszaadva (${lastMatchList.length - freshMatches.length} kiszűrve)`);
  // Standings gazdagítás a mondomatutit AI generátor számára
  const enrichedMatches = await Promise.all(freshMatches.map(m => enrichMatchWithStandings(m)));
  res.json({ matches: enrichedMatches, tippedMatches, tippedPicks, generatedAt: new Date().toISOString() });
});
