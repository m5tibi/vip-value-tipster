// ── VIP próbaidő végpontok ──────────────────────────────────
// Aktiválás e-mailes linkről (kampány) vagy a tippek oldali sávról; admin kampány + statisztika.
const express = require("express");
const usersDb = require("../users");
const auth    = require("../auth");
const trial   = require("../lib/trial");
const { requireAdmin } = require("../lib/admin");
const { notifyAdmin, esc } = require("../lib/notify");
const quota   = require("../lib/mailQuota");
const { clientIp } = require("../lib/security");

const router = express.Router();

const huDate = iso => new Date(iso).toLocaleDateString("hu-HU", { timeZone: "Europe/Budapest", month: "long", day: "numeric" });

const page = (icon, title, msg, color, btn = "⚽ Tovább a tippekhez") => `<!DOCTYPE html><html lang="hu"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#07111d;color:#cfd8dc;font-family:-apple-system,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px">
<div style="background:#0d1b2a;border:1px solid #1e3a2f;border-radius:12px;padding:28px;max-width:420px;text-align:center">
<div style="font-size:40px;margin-bottom:8px">${icon}</div>
<div style="color:${color};font-weight:700;font-size:18px;margin-bottom:8px">${title}</div>
<div style="color:#78909c;font-size:14px;line-height:1.6;margin-bottom:18px">${msg}</div>
<a href="/tippek.html" style="display:inline-block;background:#00e676;color:#07111d;font-weight:700;padding:11px 22px;border-radius:8px;text-decoration:none">${btn}</a>
</div></body></html>`;

// ── Kapacitás: a napi 100 levélbe beleférjünk ──
// Egyszerre csak annyi próbaidős lehet, amennyinek (a fizetők mellett) minden tippküldés kimegy
// (lib/mailQuota.js). A kampány-ajánlatok hullámokban mennek: csak a szabad helyekre, és egy kiküldött,
// még nem aktivált ajánlat OFFER_VALID_DAYS napig foglal helyet (utána a link lejár, a hely felszabadul).
const OFFER_VALID_DAYS = 7;
const offerOpen = u => !!(u && u.trialOffer?.emailedAt && !u.trialStartedAt &&
  Date.now() - Date.parse(u.trialOffer.emailedAt) < OFFER_VALID_DAYS * 86400000);
function capacityState() {
  const raw = usersDb.all().map(u => usersDb.findById(u.id)).filter(u => u && !u.disabled && !u.isAdmin);
  const payers = raw.filter(u => u.plan === "pro").length;
  const cap = quota.trialCapacity(payers, trial.CAMPAIGN_TRIAL_DAYS);
  const active = raw.filter(u => trial.isActive(u) && !trial.isPayer(u)).length;
  const outstanding = raw.filter(offerOpen).length;
  // Várólista: a legutóbb aktív tagok előre (náluk nagyobb az esély, hogy élnek az ajánlattal)
  const queue = raw.filter(u => u.trialOffer && !u.trialOffer.emailedAt && !u.trialStartedAt && u.plan !== "pro" && trial.eligibility(u).ok)
    .sort((a, b) => String(b.lastLoginAt || b.createdAt || "").localeCompare(String(a.lastLoginAt || a.createdAt || "")));
  return { payers, cap, active, outstanding, free: Math.max(0, cap - active - outstanding), queue };
}

// Próbaidő indítása egy felhasználónak (közös a link, a sáv és az e-mail megerősítés számára).
// Visszatér: { ok, user, days } vagy { ok:false, reason }
function startFor(u, req, source) {
  if (!auth.PAID_MODE) return { ok: false, reason: "Jelenleg minden tipp ingyenesen elérhető – próbaidőre nincs szükség." };
  // Új regisztrálónak mindig jár; a többieknek csak saját, élő ajánlattal vagy szabad hely esetén
  if (source !== "signup" && !offerOpen(u) && capacityState().free <= 0)
    return { ok: false, reason: "A próbaidős helyek most beteltek – egyszerre csak korlátozott számú próbaidő futhat. Pár nap múlva próbáld újra!" };
  const days = u.trialOffer?.days || trial.TRIAL_DAYS;
  const ip = clientIp(req);
  const r = trial.start(u, usersDb.update, { days, source: u.trialOffer ? "campaign" : source, deviceId: req.deviceId, ip });
  if (r.ok) {
    const flag = trial.ipCount(ip) > 1 ? `\n⚠️ Ugyanarról az IP-ről ${trial.ipCount(ip)} próbaidő 30 napon belül` : "";
    console.log(`VIP próbaidő indult: ${u.email} – ${days} nap (${r.user.trialSource})`);
    notifyAdmin(`💎 <b>VIP próbaidő indult</b>\n${esc(u.email)} – ${days} nap (${r.user.trialSource === "campaign" ? "kampány" : "új regisztráció"})${flag}`);
  }
  return r;
}

// Aktiváló link az e-mailből (kampány). A link csak a postafiók tulajdonosához juthat el →
// az e-mail címet is megerősíti.
router.get("/api/trial/activate", (req, res) => {
  const uid = auth.readPurposeToken("trial", req.query.token);
  if (!uid) return res.status(400).send(page("⚠️", "Érvénytelen vagy lejárt link", "Az aktiváló link lejárt vagy érvénytelen. Lépj be, és a tippek oldalon aktiválhatod a próbaidőt, ha még jár.", "#ffcc80"));
  const u = usersDb.findById(uid);
  if (!u || u.disabled) return res.status(400).send(page("⚠️", "Nincs ilyen fiók", "A fiók már nem létezik.", "#ffcc80"));
  if (u.emailVerified === false) usersDb.update(uid, { emailVerified: true });
  if (trial.isActive(u)) return res.send(page("💎", "A próbaidőd már aktív", `A VIP tippeket ${huDate(u.trialEndsAt)}-ig látod. Lépj be a fiókodba a tippek oldalon.`, "#00e676"));
  const r = startFor(usersDb.findById(uid), req, "campaign");
  if (!r.ok) return res.send(page("ℹ️", "A próbaidő nem aktiválható", esc(r.reason), "#ffcc80"));
  res.send(page("🎉", `${r.days} napos VIP próbaidő aktiválva!`,
    `Mostantól ${huDate(r.user.trialEndsAt)}-ig minden VIP tippet látsz, és e-mailben is megkapod őket. Lépj be a fiókodba (${esc(u.email)}) a tippek oldalon.`, "#00e676"));
});

// Indítás a tippek oldali sávról (belépve)
router.post("/api/trial/start", auth.requireLogin, (req, res) => {
  const u = usersDb.findById(req.user.id);
  if (u.emailVerified === false) return res.status(400).json({ error: "Előbb erősítsd meg az e-mail címed – a levélben lévő linkre kattintva indul a próbaidő." });
  const r = startFor(u, req, "banner");
  if (!r.ok) return res.status(400).json({ error: r.reason });
  res.json({ ok: true, days: r.days, endsAt: r.user.trialEndsAt });
});

// ── Admin: kampány a meglévő felhasználóknak ──
// Jogosult: nem admin, nem előfizető, nem tiltott, még nem volt próbaidőn és nem kapott ajánlatot.
// dryRun: csak megszámolja. Az e-maileket a szerver ütemezője küldi napi kerettel (lásd server.js).
router.post("/api/admin/trial-campaign", (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!auth.PAID_MODE) return res.status(400).json({ error: "A fizetős mód ki van kapcsolva (PAID_MODE) – most mindenki látja a tippeket, a próbaidőnek nincs értelme." });
  const raw = usersDb.all().map(u => usersDb.findById(u.id));
  // Akinek úgysem járna (eldobható cím, ugyanaz a Gmail-cím, már próbaidős eszköz), annak nem küldünk
  const targets = raw.filter(u => u && !u.trialOffer && trial.eligibility(u).ok);
  if (req.body?.dryRun) return res.json({ ok: true, count: targets.length, days: trial.CAMPAIGN_TRIAL_DAYS });
  const offeredAt = new Date().toISOString();
  targets.forEach(u => usersDb.update(u.id, { trialOffer: { days: trial.CAMPAIGN_TRIAL_DAYS, offeredAt, emailedAt: null } }));
  console.log(`Próbaidő-kampány indítva: ${targets.length} felhasználó (${trial.CAMPAIGN_TRIAL_DAYS} nap)`);
  res.json({ ok: true, count: targets.length, days: trial.CAMPAIGN_TRIAL_DAYS });
});

router.get("/api/admin/trial-stats", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const raw = usersDb.all().map(u => usersDb.findById(u.id)).filter(u => u && !u.isAdmin);
  const started = raw.filter(u => u.trialStartedAt);
  const ended = started.filter(u => !trial.isActive(u));
  const converted = started.filter(u => trial.isPayer(u));
  const decided = started.filter(u => !trial.isActive(u) || trial.isPayer(u));   // lejárt vagy már előfizetett
  const offered = raw.filter(u => u.trialOffer);
  const cs = capacityState();
  res.json({
    started: started.length, active: started.filter(u => trial.isActive(u)).length,
    bySource: started.reduce((a, u) => (a[u.trialSource || "?"] = (a[u.trialSource || "?"] || 0) + 1, a), {}),
    ended: ended.length, converted: converted.length,
    conversionPct: decided.length ? Math.round(converted.length / decided.length * 100) : null,
    campaign: { offered: offered.length, emailed: offered.filter(u => u.trialOffer.emailedAt).length,
                pending: offered.filter(u => !u.trialOffer.emailedAt && !u.trialStartedAt).length,
                activated: offered.filter(u => u.trialStartedAt).length },
    trialDays: trial.TRIAL_DAYS, campaignDays: trial.CAMPAIGN_TRIAL_DAYS,
    capacity: { cap: cs.cap, active: cs.active, outstanding: cs.outstanding, free: cs.free, queue: cs.queue.length, payers: cs.payers },
    mail: { used: quota.used(), limit: quota.LIMIT, reserve: quota.RESERVE, sendsPerDay: quota.sendsPerDay() },
  });
});

module.exports = { router, startFor, capacityState, offerOpen, OFFER_VALID_DAYS };
