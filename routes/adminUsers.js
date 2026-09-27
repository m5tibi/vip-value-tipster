// ── Admin: felhasználók kezelése ─────────────────────────
const express = require("express");
const usersDb = require("../users");
const mailer  = require("../mailer");
const { requireAdmin } = require("../lib/admin");

const router = express.Router();

router.get("/api/admin/users", (req, res) => {
  if (!requireAdmin(req, res)) return;
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

router.delete("/api/admin/users/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  usersDb.update(req.params.id, { disabled: true, plan: "free" });
  console.log(`Felhasználó deaktiválva: ${req.params.id}`);
  res.json({ ok: true });
});

module.exports = router;
