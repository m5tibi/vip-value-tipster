// ── Napi e-mail keret (Resend ingyenes csomag: 100 levél / nap) ─────────────
// Minden kiküldött levelet számolunk (magyar naptári nap szerint, a fájl túléli az újraindítást).
// - A tömeges levelek (tipp-értesítő, próbaidő-ajánlat) csak addig mennek, amíg a napi keretből
//   legalább MAIL_RESERVE marad – ez a tartalék a fontos levelekre (megerősítés, jelszó, fizetés).
// - A próbaidő-kapacitás: ennyi próbaidős fér bele egy napba úgy, hogy minden tippküldés minden
//   fizetőnek és próbaidősnek kimenjen. A napi tippküldések számát az elmúlt 7 napból mérjük.
const fs   = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/data";
const FILE     = path.join(DATA_DIR, "mail-quota.json");
const LIMIT    = parseInt(process.env.MAIL_DAILY_LIMIT, 10) || 100;
const RESERVE  = parseInt(process.env.MAIL_RESERVE, 10) || 15;

const huDay = (d = new Date()) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Budapest" });  // YYYY-MM-DD

let state = { day: huDay(), count: 0, tipSends: [] };   // tipSends: a tippküldések napjai (YYYY-MM-DD)
try { if (fs.existsSync(FILE)) state = { ...state, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch (e) {}
function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE + ".tmp", JSON.stringify(state));
    fs.renameSync(FILE + ".tmp", FILE);
  } catch (e) { console.error("mail-quota mentési hiba:", e.message); }
}
function roll() { const d = huDay(); if (state.day !== d) { state.day = d; state.count = 0; save(); } }

const used      = () => { roll(); return state.count; };
const remaining = () => Math.max(0, LIMIT - used());
const bulkLeft  = () => Math.max(0, remaining() - RESERVE);     // ennyi tömeges levél mehet még ma
function note(n = 1) { roll(); state.count += n; save(); }

// Tippküldés naplózása és a napi átlag (az elmúlt 7 nap küldéses napjain, felfelé kerekítve, min. 1)
function noteTipSend() {
  const cutoff = huDay(new Date(Date.now() - 7 * 86400000));
  state.tipSends = [...(state.tipSends || []).filter(d => d > cutoff), huDay()];
  save();
}
function sendsPerDay() {
  const cutoff = huDay(new Date(Date.now() - 7 * 86400000));
  const days = (state.tipSends || []).filter(d => d > cutoff);
  if (!days.length) return 1;
  return Math.max(1, Math.ceil(days.length / new Set(days).size));
}
const tipSendsToday = () => (state.tipSends || []).filter(d => d === huDay()).length;

// Egyszerre legfeljebb ennyi próbaidős lehet (a fizetők mellett). TRIAL_MAX_ACTIVE env felülírja.
// Egy próbaidős napi levélköltsége: minden tippküldés + a próbaidő 3 saját levele (ajánlat,
// emlékeztető, lejárat) a próbaidő napjaira elosztva.
function trialCapacity(payers, trialDays = 7) {
  const fixed = parseInt(process.env.TRIAL_MAX_ACTIVE, 10);
  if (fixed >= 0) return fixed;
  const perTrialPerDay = sendsPerDay() + 3 / Math.max(1, trialDays);
  return Math.max(0, Math.floor((LIMIT - RESERVE) / perTrialPerDay) - payers);
}

module.exports = { LIMIT, RESERVE, used, remaining, bulkLeft, note, noteTipSend, sendsPerDay, tipSendsToday, trialCapacity };
