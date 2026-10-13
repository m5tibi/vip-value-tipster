// ── Ingyenes VIP próbaidő (bankkártya nélkül) ────────────────
// - Új felhasználó: az e-mail megerősítésekor automatikusan indul (TRIAL_DAYS, alapból 5 nap).
// - Meglévők: egyszeri kampány (CAMPAIGN_TRIAL_DAYS, alapból 7 nap) – e-mailben kapott linkkel
//   vagy a tippek oldali sávval aktiválják; a napok az aktiváláskor indulnak.
// Visszaélés ellen (több e-mail címmel regisztrálás):
//   1) csak megerősített e-mail címre; 2) eldobható e-mail szolgáltatókra nem jár;
//   3) Gmail-trükkök (pont, +címke) egy címnek számítanak; 4) eszközönként (tartós süti) egy próbaidő;
//   5) az IP csak jelzés az adminnak (mobilhálózaton sokan osztoznak egy IP-n, ezért nem tiltunk).
// A kiosztott próbaidőket külön napló (trials.json) őrzi, így egy fiók törlése után sem jár újra.
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const DATA_DIR     = process.env.DATA_DIR || "/data";
const TRIALS_FILE  = path.join(DATA_DIR, "trials.json");
const TRIAL_DAYS          = Math.max(1, parseInt(process.env.TRIAL_DAYS, 10) || 5);
const CAMPAIGN_TRIAL_DAYS = Math.max(1, parseInt(process.env.CAMPAIGN_TRIAL_DAYS, 10) || 7);
const DEVICE_COOKIE = "did";
const IP_FLAG_DAYS  = 30;

// Gyakori eldobható (ideiglenes) e-mail szolgáltatók; bővíthető: DISPOSABLE_DOMAINS env (vesszővel)
const DISPOSABLE = new Set([
  "10minutemail.com", "10minutemail.net", "20minutemail.com", "guerrillamail.com", "guerrillamail.net",
  "guerrillamail.org", "guerrillamail.de", "sharklasers.com", "grr.la", "guerrillamailblock.com",
  "mailinator.com", "mailinator.net", "mailinator2.com", "temp-mail.org", "temp-mail.io", "tempmail.com",
  "tempmail.net", "tempmailo.com", "tempail.com", "tempr.email", "throwawaymail.com", "trashmail.com",
  "trashmail.de", "trashmail.net", "yopmail.com", "yopmail.fr", "yopmail.net", "getnada.com", "nada.email",
  "dispostable.com", "maildrop.cc", "mailnesia.com", "mohmal.com", "mintemail.com", "emailondeck.com",
  "fakeinbox.com", "spamgourmet.com", "mytemp.email", "tempinbox.com", "burnermail.io", "33mail.com",
  "getairmail.com", "inboxkitten.com", "mail.tm", "mailpoof.com", "moakt.com", "tmpmail.org", "tmpmail.net",
  "minuteinbox.com", "discard.email", "dropmail.me", "emailfake.com", "fakemail.net", "spambox.us",
  "mail-temp.com", "luxusmail.org", "1secmail.com", "1secmail.org", "1secmail.net", "linshiyouxiang.net",
  "byom.de", "einrot.com", "wegwerfmail.de", "trash-mail.com", "spam4.me", "anonaddy.me", "tempmailaddress.com",
  ...String(process.env.DISPOSABLE_DOMAINS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
]);

// Egységes cím: kisbetű, +címke nélkül; Gmailnél a pontok sem számítanak (a.b@gmail.com = ab@gmail.com)
function canonEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return e;
  let local = e.slice(0, at).split("+")[0];
  let domain = e.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}
const emailDomain = email => String(email || "").trim().toLowerCase().split("@").pop();
const isDisposable = email => {
  const d = emailDomain(email);
  return DISPOSABLE.has(d) || [...DISPOSABLE].some(x => d.endsWith("." + x));
};

// ── Napló (trials.json) ──
let ledger = [];
function load() {
  try { ledger = fs.existsSync(TRIALS_FILE) ? JSON.parse(fs.readFileSync(TRIALS_FILE, "utf8")) || [] : []; }
  catch (e) { console.error("trials.json betöltési hiba:", e.message); ledger = []; }
}
function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = TRIALS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
    fs.renameSync(tmp, TRIALS_FILE);
  } catch (e) { console.error("trials.json mentési hiba:", e.message); }
}
load();

// ── Eszköz-azonosító: tartós, httpOnly süti (inkognitó ablak ellen nem véd, de a sima újraregisztrálás ellen igen) ──
function deviceMiddleware(req, res, next) {
  let id = req.cookies?.[DEVICE_COOKIE];
  if (!id || !/^[a-f0-9]{32}$/.test(id)) {
    id = crypto.randomBytes(16).toString("hex");
    res.cookie(DEVICE_COOKIE, id, {
      httpOnly: true, secure: process.env.NODE_ENV !== "development", sameSite: "lax",
      maxAge: 2 * 365 * 24 * 3600 * 1000, path: "/",
    });
  }
  req.deviceId = id;
  next();
}

// A fiókhoz használt eszközök megjegyzése (regisztráció, belépés) – legfeljebb az utolsó 5
function rememberDevice(u, deviceId, update) {
  if (!u || !deviceId) return;
  const list = (u.devices || []).filter(d => d !== deviceId);
  update(u.id, { devices: [...list, deviceId].slice(-5) });
}

// ── Állapot ──
const isActive = u => !!(u && u.trialEndsAt && new Date(u.trialEndsAt) > new Date());
const daysLeft = u => isActive(u) ? Math.max(1, Math.ceil((new Date(u.trialEndsAt) - Date.now()) / 86400000)) : 0;
const isPayer  = u => !!u && u.plan === "pro";

// Kaphat-e próbaidőt? { ok, reason } – a reason a felhasználónak is megjeleníthető
function eligibility(u, { deviceId } = {}) {
  if (!u || u.disabled)     return { ok: false, reason: "Nincs ilyen fiók." };
  if (u.isAdmin)            return { ok: false, reason: "Admin fiók." };
  if (u.plan === "pro")     return { ok: false, reason: "Már előfizető vagy." };
  if (u.trialStartedAt)     return { ok: false, reason: "A próbaidőt már felhasználtad." };
  if (isDisposable(u.email)) return { ok: false, reason: "Eldobható (ideiglenes) e-mail címre nem jár próbaidő." };
  const canon = canonEmail(u.email);
  if (ledger.some(x => x.canonEmail === canon && x.userId !== u.id))
    return { ok: false, reason: "Ehhez az e-mail címhez már tartozott próbaidő." };
  // Az aktuális eszköz és a fiókhoz korábban (regisztráció/belépés) használt eszközök
  const devices = new Set([deviceId, ...(u.devices || [])].filter(Boolean));
  if (ledger.some(x => x.device && devices.has(x.device) && x.userId !== u.id))
    return { ok: false, reason: "Erről az eszközről már aktiváltak próbaidőt." };
  return { ok: true };
}

// Hány próbaidő indult ugyanarról az IP-ről az utóbbi 30 napban (admin jelzés)
function ipCount(ip) {
  if (!ip) return 0;
  const since = Date.now() - IP_FLAG_DAYS * 86400000;
  return ledger.filter(x => x.ip === ip && new Date(x.at).getTime() >= since).length;
}

// Próbaidő indítása. update: (id, patch) → user (users.js). Visszatér: { ok, user, days } vagy { ok:false, reason }
function start(u, update, { days, source, deviceId, ip }) {
  const el = eligibility(u, { deviceId });
  if (!el.ok) return el;
  const now = new Date();
  const ends = new Date(now.getTime() + days * 86400000);
  const user = update(u.id, {
    trialStartedAt: now.toISOString(), trialEndsAt: ends.toISOString(), trialDays: days, trialSource: source,
    trialDevice: deviceId || null, trialIp: ip || null, trialReminderSent: false, trialExpiredSent: false,
  });
  ledger.push({ userId: u.id, canonEmail: canonEmail(u.email), device: deviceId || null, ip: ip || null, at: now.toISOString(), source, days });
  save();
  return { ok: true, user, days };
}

// A /api/auth/me-be kerülő állapot
function status(u, deviceId) {
  if (!u) return null;
  if (isActive(u)) return { active: true, endsAt: u.trialEndsAt, daysLeft: daysLeft(u), days: u.trialDays || null };
  if (u.trialStartedAt) return { active: false, used: true, endsAt: u.trialEndsAt };
  if (u.isAdmin || u.plan === "pro") return null;
  const el = eligibility(u, { deviceId });
  return {
    active: false, used: false, eligible: el.ok, reason: el.ok ? null : el.reason,
    needVerify: u.emailVerified === false,
    days: u.trialOffer?.days || TRIAL_DAYS,
  };
}

// Admin-jelzések egy felhasználóhoz (canonCount: hány fiók tartozik ugyanahhoz az egységesített címhez)
function flags(u, canonCount = 1) {
  const out = [];
  if (u.trialIp && ipCount(u.trialIp) > 1) out.push(`ugyanarról az IP-ről ${ipCount(u.trialIp)} próbaidő ${IP_FLAG_DAYS} napon belül`);
  if (canonCount > 1) out.push(`${canonCount} fiók ugyanazzal a címmel (${canonEmail(u.email)})`);
  if (isDisposable(u.email)) out.push("eldobható e-mail cím");
  return out;
}

module.exports = {
  TRIAL_DAYS, CAMPAIGN_TRIAL_DAYS, canonEmail, isDisposable, deviceMiddleware,
  isActive, daysLeft, isPayer, eligibility, start, status, flags, ipCount, rememberDevice,
  ledgerSize: () => ledger.length,
};
