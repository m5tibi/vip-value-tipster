// ── Admin: felhasználók kezelése ─────────────────────────
const express = require("express");
const usersDb = require("../users");
const mailer  = require("../mailer");
const trial   = require("../lib/trial");
const auth    = require("../auth");
const { requireAdmin } = require("../lib/admin");

const router = express.Router();

router.get("/api/admin/users", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const canonCount = {};
  usersDb.all().forEach(u => { const c = trial.canonEmail(u.email); canonCount[c] = (canonCount[c] || 0) + 1; });
  const list = usersDb.all().map(u => ({
    id: u.id,
    email: u.email,
    plan: u.plan || "free",
    emailVerified: u.emailVerified !== false,
    isAdmin: !!u.isAdmin,
    createdAt: u.createdAt || null,
    paidUntil: u.paidUntil || null,
    cancelledAt: u.cancelledAt || null,
    subscriptionStatus: u.subscriptionStatus || null,
    stripeCustomerId: u.stripeCustomerId || null,
    trialStartedAt: u.trialStartedAt || null,
    trialEndsAt: u.trialEndsAt || null,
    trialSource: u.trialSource || null,
    trialOffer: u.trialOffer || null,
    trialFlags: trial.flags(usersDb.findById(u.id) || u, canonCount[trial.canonEmail(u.email)]),
    disabled: !!(usersDb.findById(u.id) || {}).disabled,
    disabledAt: (usersDb.findById(u.id) || {}).disabledAt || null,
  }));
  res.json(list);
});

router.patch("/api/admin/users/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { plan, paidUntil } = req.body;
  const validPlan = ["free","pro"].includes(plan) ? plan : "free";
  const targetUser = usersDb.findById(req.params.id);
  const subStatus = validPlan === "pro" ? "active" : "cancelled";
  const cancelledAt = validPlan === "free" ? new Date().toISOString() : null;
  usersDb.update(req.params.id, { plan: validPlan, paidUntil, subscriptionStatus: subStatus, currentPeriodEnd: paidUntil || null, ...(cancelledAt ? { cancelledAt } : {}) });
  console.log(`Felhasználó frissítve: ${req.params.id} → plan:${validPlan}`);
  if (targetUser) {
    if (validPlan === "pro") {
      mailer.sendPlanActivated(targetUser.email, paidUntil).catch(e => console.error("Email hiba:", e.message));
    } else if (validPlan === "free" && targetUser.plan === "pro") {
      mailer.sendPlanCancelled(targetUser.email).catch(e => console.error("Email hiba:", e.message));
    }
  }
  res.json({ ok: true });
});

// Tag kizárása: nem tud belépni (a meglévő munkamenete is érvénytelen), nem kap levelet, a fizetős
// hozzáférése megszűnik. Visszaengedhető – ekkor a korábbi csomagja visszaáll. (A Stripe-előfizetést
// ez NEM mondja le: azt a Stripe-ban kell.)
router.delete("/api/admin/users/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const u = usersDb.findById(req.params.id);
  if (!u) return res.status(404).json({ error: "Nincs ilyen felhasználó" });
  if (u.isAdmin) return res.status(400).json({ error: "Admin fiók nem zárható ki" });
  if (u.disabled) return res.json({ ok: true, already: true });
  const hadStripe = !!u.stripeCustomerId && u.plan === "pro";       // az update előtt (az update helyben módosít)
  usersDb.update(u.id, { disabled: true, disabledAt: new Date().toISOString(), planBeforeDisable: u.plan || "free", plan: "free" });
  console.log(`Tag kizárva: ${u.email}`);
  res.json({ ok: true, hadStripe });
});

router.post("/api/admin/users/:id/enable", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const u = usersDb.findById(req.params.id);
  if (!u) return res.status(404).json({ error: "Nincs ilyen felhasználó" });
  usersDb.update(u.id, { disabled: false, disabledAt: null, plan: u.planBeforeDisable || u.plan || "free", planBeforeDisable: null });
  console.log(`Tag visszaengedve: ${u.email}`);
  res.json({ ok: true });
});

// Kézi e-mail megerősítés (pl. megtelt postafiók miatt nem ért célba a megerősítő levél, de a cím valódi).
// Új tagnál – ahogy a linkes megerősítésnél – elindul a VIP próbaidő is, ha jár (eszköz/IP nélkül:
// az admin eszközét nem rögzítjük; a fiók korábbi eszközeit az ellenőrzés így is figyeli).
router.post("/api/admin/users/:id/verify", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const u = usersDb.findById(req.params.id);
  if (!u) return res.status(404).json({ error: "Nincs ilyen felhasználó" });
  usersDb.update(u.id, { emailVerified: true, verifiedByAdminAt: new Date().toISOString() });
  let trialRes = null;
  const fresh = usersDb.findById(u.id);
  if (auth.PAID_MODE && !fresh.trialStartedAt && fresh.plan !== "pro" && !fresh.isAdmin && !fresh.disabled) {
    const r = trial.start(fresh, usersDb.update, { days: fresh.trialOffer?.days || trial.TRIAL_DAYS, source: "admin", deviceId: null, ip: null });
    trialRes = r.ok ? { ok: true, days: r.days, endsAt: r.user.trialEndsAt } : { ok: false, reason: r.reason };
  }
  console.log(`E-mail kézzel megerősítve: ${u.email}${trialRes?.ok ? ` · VIP próbaidő indult (${trialRes.days} nap)` : ""}`);
  res.json({ ok: true, trial: trialRes });
});

module.exports = router;
