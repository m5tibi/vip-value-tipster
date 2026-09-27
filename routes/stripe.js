// ── Stripe: webhook, checkout, ügyfélportál, státusz, admin szinkron ──
const express = require("express");
const usersDb = require("../users");
const auth    = require("../auth");
const mailer  = require("../mailer");
const { BASE_URL }     = require("../lib/config");
const { requireAdmin } = require("../lib/admin");

const STRIPE_SECRET  = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PRICE   = process.env.STRIPE_PRICE_ID;
const stripe = STRIPE_SECRET ? require("stripe")(STRIPE_SECRET) : null;

// Webhook – a server.js express.raw-val, a json middleware ELŐTT köti be
async function webhook(req, res) {
  if (!stripe) return res.status(500).json({ error: "Stripe nincs konfigurálva" });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK);
  } catch (err) {
    console.error("Stripe webhook aláírás hiba:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Azonnal 200-at küldünk – Stripe ne próbálja újraküldeni (duplikált számla ellen)
  res.json({ received: true });

  const updateUser = (customerId, email, patch) => {
    const u = (email && usersDb.findByEmail(email)) || usersDb.findByStripeCustomer(customerId);
    if (u) { usersDb.update(u.id, patch); return u; }
    return null;
  };

  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    let paidUntil = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();
    // Stripe-tól lekérjük a tényleges előfizetési időszak végét
    if (s.subscription && stripe) {
      try {
        const sub = await stripe.subscriptions.retrieve(s.subscription);
        if (sub.current_period_end) {
          paidUntil = new Date(sub.current_period_end * 1000).toISOString();
        }
      } catch(e) { console.error("Stripe subscription lekérés hiba:", e.message); }
    }
    const u = updateUser(s.customer, s.customer_details?.email || s.customer_email, {
      plan: "pro", stripeCustomerId: s.customer, paidUntil,
      subscriptionStatus: "active", currentPeriodEnd: paidUntil,
      stripeSubscriptionId: s.subscription || null
    });
    if (u) {
      console.log(`Stripe ✓ előfizetés aktiválva: ${u.email}, lejár: ${paidUntil}`);
      mailer.sendPlanActivated(u.email, paidUntil).catch(e => console.error("Email hiba:", e.message));
    }
    else console.warn(`Stripe: felhasználó nem található – ${s.customer_details?.email}`);
  }

  if (event.type === "invoice.payment_succeeded") {
    const inv = event.data.object;
    if (inv.billing_reason === "subscription_cycle") {
      const periodEnd = inv.lines?.data?.[0]?.period?.end;
      const paidUntil = periodEnd
        ? new Date(periodEnd * 1000).toISOString()
        : new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();
      const u = updateUser(inv.customer, null, { paidUntil, subscriptionStatus: "active", currentPeriodEnd: paidUntil });
      if (u) console.log(`Stripe ✓ megújítva: ${u.email}, lejár: ${paidUntil}`);
    }
  }

  if (event.type === "customer.subscription.updated") {
    const sub  = event.data.object;
    const prev = event.data.previous_attributes || {};
    console.log(`Stripe subscription.updated – cancel_at_period_end: ${sub.cancel_at_period_end}, status: ${sub.status}, prev keys: [${Object.keys(prev).join(",")}], prev.cancel_at_period_end: ${prev.cancel_at_period_end}`);
    const justCancelled = sub.cancel_at_period_end &&
      sub.status === "active" &&
      ('cancel_at_period_end' in prev || prev.cancel_at_period_end === false);
    console.log(`  justCancelled: ${justCancelled}`);
    if (justCancelled) {
      const cancelledAt  = new Date().toISOString();
      const periodEndTs  = sub.cancel_at || sub.current_period_end;
      const periodEnd    = periodEndTs ? new Date(periodEndTs * 1000).toISOString() : null;
      const patch        = { cancelledAt, ...(periodEnd ? { paidUntil: periodEnd } : {}) };
      const u = updateUser(sub.customer, null, patch);
      if (u) {
        const endStr = periodEnd ? new Date(periodEnd).toLocaleDateString("hu-HU") : (u.paidUntil ? new Date(u.paidUntil).toLocaleDateString("hu-HU") : "–");
        console.log(`Stripe: lemondva (időszak végéig aktív) – ${u.email}, lejár: ${endStr}`);
        const adminEmail = process.env.ADMIN_EMAIL;
        if (adminEmail) mailer.send({
          to: adminEmail,
          subject: `❌ Előfizetés lemondva – ${u.email}`,
          text: `${u.email} lemondta előfizetését. Aktív marad: ${endStr}`,
          html: `<p>A <b>${u.email}</b> lemondta a 90perc.hu előfizetését.</p><p>Aktív marad: <b>${endStr}</b></p>`,
        }).catch(e => console.error("Admin email hiba:", e.message));
        mailer.sendSubscriptionCancelled(u.email, periodEnd || u.paidUntil).catch(e => console.error("Email hiba:", e.message));
      }
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    const cancelledAt = new Date().toISOString();
    const u = updateUser(sub.customer, null, { plan: "free", paidUntil: null, subscriptionStatus: "cancelled", currentPeriodEnd: null, cancelledAt });
    if (u) {
      console.log(`Stripe: lemondva – ${u.email}`);
      mailer.sendSubscriptionExpired(u.email).catch(e => console.error("Email hiba:", e.message));
      // Admin értesítő
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) mailer.send({
        to: adminEmail,
        subject: `❌ Előfizetés lemondva – ${u.email}`,
        text: `${u.email} lemondta az előfizetését.`,
        html: `<p>A <b>${u.email}</b> felhasználó lemondta a 90perc.hu előfizetését.</p><p>Lemondás időpontja: ${cancelledAt}</p>`,
      }).catch(e => console.error("Admin email hiba:", e.message));
    }
  }

}

const router = express.Router();

// ── Stripe: Checkout Session létrehozása ─────────────────────
router.post("/api/stripe/checkout", auth.requireLogin, async (req, res) => {
  if (!stripe)       return res.status(500).json({ error: "Stripe nincs konfigurálva" });
  if (!STRIPE_PRICE) return res.status(500).json({ error: "STRIPE_PRICE_ID nincs beállítva" });
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: req.user.email,
      line_items: [{ price: STRIPE_PRICE, quantity: 1 }],
      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${BASE_URL}/elofizetes.html`,
      metadata:    { userId: req.user.id },
      locale:                   "hu",
      allow_promotion_codes:    true,
      billing_address_collection: "required",
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout hiba:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Stripe: Ügyfélportál (előfizetés kezelése / lemondás) ─────
router.post("/api/stripe/portal", auth.requireLogin, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "Stripe nincs konfigurálva" });
  const user = usersDb.findById(req.user.id);
  if (!user?.stripeCustomerId) return res.status(400).json({ error: "Nincs aktív előfizetés" });
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer:   user.stripeCustomerId,
      return_url: `${BASE_URL}/tippek.html`,
    });
    res.json({ url: portal.url });
  } catch (err) {
    console.error("Stripe portal hiba:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Stripe: Előfizetés státusz ────────────────────────────────
router.get("/api/stripe/status", auth.requireLogin, (req, res) => {
  const user = usersDb.findById(req.user.id);
  res.json({
    plan:            user?.plan || "free",
    paidUntil:       user?.paidUntil || null,
    hasStripe:       !!user?.stripeCustomerId,
    stripeConfigured: !!stripe && !!STRIPE_PRICE,
  });
});

// ── Admin: paidUntil szinkronizálás Stripe-ból ───────────────
router.post("/api/admin/sync-stripe", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!stripe) return res.status(500).json({ error: "Stripe nincs konfigurálva" });
  const proUsers = usersDb.all().filter(u => u.plan === "pro");
  console.log(`Stripe sync: ${proUsers.length} pro felhasználó keresése...`);
  let updated = 0;
  for (const u of proUsers) {
    try {
      let sub = null;
      // 1. Ha van stripeCustomerId, azzal keresünk
      if (u.stripeCustomerId) {
        const subs = await stripe.subscriptions.list({ customer: u.stripeCustomerId, status: "active", limit: 1 });
        if (subs.data.length) sub = subs.data[0];
      }
      // 2. Ha nincs vagy nem találtuk, email alapján keresünk
      if (!sub) {
        const customers = await stripe.customers.list({ email: u.email, limit: 1 });
        if (customers.data.length) {
          const cust = customers.data[0];
          const subs = await stripe.subscriptions.list({ customer: cust.id, status: "active", limit: 1 });
          if (subs.data.length) {
            sub = subs.data[0];
            usersDb.update(u.id, { stripeCustomerId: cust.id });
            console.log(`  Stripe customer ID beállítva: ${u.email} → ${cust.id}`);
          }
        }
      }
      if (sub) {
        const paidUntil = new Date(sub.current_period_end * 1000).toISOString();
        usersDb.update(u.id, { paidUntil, subscriptionStatus: "active", currentPeriodEnd: paidUntil });
        console.log(`  Stripe sync OK: ${u.email} → lejár: ${paidUntil}`);
        updated++;
      } else {
        console.log(`  Nincs aktív Stripe előfizetés: ${u.email}`);
      }
    } catch(e) { console.error(`Stripe sync hiba (${u.email}):`, e.message); }
  }
  res.json({ ok: true, updated, total: proUsers.length });
});

module.exports = { webhook, router };
