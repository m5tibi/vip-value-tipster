// ── Stripe: webhook, checkout, ügyfélportál, státusz, admin szinkron ──
const express = require("express");
const usersDb = require("../users");
const auth    = require("../auth");
const mailer  = require("../mailer");
const { BASE_URL }     = require("../lib/config");
const { requireAdmin } = require("../lib/admin");
const { notifyAdmin, esc, huDate, activeSubscribers } = require("../lib/notify");

const STRIPE_SECRET  = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PRICE   = process.env.STRIPE_PRICE_ID;
const stripe = STRIPE_SECRET ? require("stripe")(STRIPE_SECRET) : null;

// Kézi hosszabbítás (admin): ha a Stripe-ban nem tudtuk eltolni (pl. lemondott előfizetés), a saját
// adatbázisunkban él (extendedUntil). Ilyenkor a Stripe-ból jövő dátum nem írhatja felül a későbbit.
const keepExt = (u, iso) => (u && u.extendedUntil && iso && u.extendedUntil > iso ? u.extendedUntil : iso);

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
      notifyAdmin(`🎉 <b>Új előfizető!</b>\n${esc(u.email)}\nLejár: ${huDate(paidUntil)}\nAktív előfizetők: ${activeSubscribers()}`);
    }
    else {
      console.warn(`Stripe: felhasználó nem található – ${s.customer_details?.email}`);
      notifyAdmin(`⚠️ <b>Sikeres fizetés, de nincs hozzá fiók!</b>\n${esc(s.customer_details?.email || s.customer_email || s.customer)}\nKézzel kell beállítani a tagok oldalon.`);
    }
  }

  if (event.type === "invoice.payment_succeeded") {
    const inv = event.data.object;
    if (inv.billing_reason === "subscription_cycle") {
      const periodEnd = inv.lines?.data?.[0]?.period?.end;
      const paidUntil = periodEnd
        ? new Date(periodEnd * 1000).toISOString()
        : new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();
      const u = updateUser(inv.customer, null, { paidUntil, subscriptionStatus: "active", currentPeriodEnd: paidUntil });
      if (u) {
        console.log(`Stripe ✓ megújítva: ${u.email}, lejár: ${paidUntil}`);
        notifyAdmin(`💳 <b>Előfizetés megújítva</b>\n${esc(u.email)}\nÚj lejárat: ${huDate(paidUntil)}`);
      }
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
      const cur          = usersDb.findByStripeCustomer(sub.customer);
      const endIso       = keepExt(cur, periodEnd);
      const patch        = { cancelledAt, ...(endIso ? { paidUntil: endIso, currentPeriodEnd: endIso } : {}) };
      const u = updateUser(sub.customer, null, patch);
      if (u) {
        const endStr = endIso ? new Date(endIso).toLocaleDateString("hu-HU") : (u.paidUntil ? new Date(u.paidUntil).toLocaleDateString("hu-HU") : "–");
        console.log(`Stripe: lemondva (időszak végéig aktív) – ${u.email}, lejár: ${endStr}`);
        const adminEmail = process.env.ADMIN_EMAIL;
        if (adminEmail) mailer.send({
          to: adminEmail,
          subject: `❌ Előfizetés lemondva – ${u.email}`,
          text: `${u.email} lemondta előfizetését. Aktív marad: ${endStr}`,
          html: `<p>A <b>${u.email}</b> lemondta a 90perc.hu előfizetését.</p><p>Aktív marad: <b>${endStr}</b></p>`,
        }).catch(e => console.error("Admin email hiba:", e.message));
        mailer.sendSubscriptionCancelled(u.email, endIso || u.paidUntil).catch(e => console.error("Email hiba:", e.message));
        notifyAdmin(`❌ <b>Előfizetés lemondva</b>\n${esc(u.email)}\nAktív marad: ${esc(endStr)}`);
      }
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    const cancelledAt = new Date().toISOString();
    const ext = usersDb.findByStripeCustomer(sub.customer);
    if (ext && ext.extendedUntil && new Date(ext.extendedUntil) > new Date()) {
      // A Stripe-előfizetés véget ért, de kézi hosszabbítást kapott: addig marad VIP, utána a napi
      // lejárat-ellenőrzés (server.js checkExpiredSubscriptions) minősíti vissza és küldi a levelet.
      usersDb.update(ext.id, { paidUntil: ext.extendedUntil, currentPeriodEnd: ext.extendedUntil, subscriptionStatus: "active",
        cancelledAt: ext.cancelledAt || cancelledAt, stripeSubscriptionId: null });
      console.log(`Stripe: előfizetés vége, de kézi hosszabbítás miatt ${ext.extendedUntil}-ig aktív – ${ext.email}`);
      return;
    }
    const u = updateUser(sub.customer, null, { plan: "free", paidUntil: null, subscriptionStatus: "cancelled", currentPeriodEnd: null, cancelledAt });
    if (u) {
      console.log(`Stripe: lemondva – ${u.email}`);
      mailer.sendSubscriptionExpired(u.email).catch(e => console.error("Email hiba:", e.message));
      notifyAdmin(`⛔ <b>Előfizetés megszűnt</b>\n${esc(u.email)}\nAktív előfizetők: ${activeSubscribers()}`);
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
        sub = await liveSub(u.stripeCustomerId);
      }
      // 2. Ha nincs vagy nem találtuk, email alapján keresünk
      if (!sub) {
        const customers = await stripe.customers.list({ email: u.email, limit: 1 });
        if (customers.data.length) {
          const cust = customers.data[0];
          sub = await liveSub(cust.id);
          if (sub) {
            usersDb.update(u.id, { stripeCustomerId: cust.id });
            console.log(`  Stripe customer ID beállítva: ${u.email} → ${cust.id}`);
          }
        }
      }
      if (sub) {
        const paidUntil = keepExt(u, new Date(sub.current_period_end * 1000).toISOString());
        usersDb.update(u.id, { paidUntil, subscriptionStatus: "active", currentPeriodEnd: paidUntil, stripeSubscriptionId: sub.id });
        console.log(`  Stripe sync OK: ${u.email} → lejár: ${paidUntil}`);
        updated++;
      } else {
        console.log(`  Nincs aktív Stripe előfizetés: ${u.email}`);
      }
    } catch(e) { console.error(`Stripe sync hiba (${u.email}):`, e.message); }
  }
  res.json({ ok: true, updated, total: proUsers.length });
});

// ── Admin: lejárat kézi módosítása (pl. tippmentes napok kompenzálása) ──
// A Stripe-on megújuló előfizetésnél a Stripe-ban is eltoljuk a következő terhelést (trial_end, arányosítás
// nélkül): a tag ennyi napot ingyen kap, és a terhelés is ennyivel később jön. Lemondott (időszak végén
// megszűnő) vagy kézzel beállított előfizetésnél csak nálunk nő a lejárat (extendedUntil).
const DAY = 86400000;

// Élő (aktív vagy próbaidős) Stripe-előfizetés egy ügyfélhez
async function liveSub(customerId) {
  const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 10 });
  return subs.data.find(s => ["active", "trialing"].includes(s.status)) || null;
}

async function extendOne(u, days) {
  const now = Date.now();
  // Próbaidős (nem fizető) tag: a próbaidő vége tolódik
  if (u.plan !== "pro") {
    const base = Math.max(now, Date.parse(u.trialEndsAt) || now);
    const end = new Date(base + days * DAY);
    if (end.getTime() <= now + 3600000) return { ok: false, email: u.email, error: "a próbaidő a múltba kerülne" };
    usersDb.update(u.id, { trialEndsAt: end.toISOString(), trialReminderSent: false });
    return { ok: true, email: u.email, kind: "trial", newEnd: end.toISOString() };
  }
  const base = Math.max(now, Date.parse(u.paidUntil) || now);
  const end = new Date(base + days * DAY);
  if (end.getTime() <= now + 3600000) return { ok: false, email: u.email, error: "a lejárat a múltba kerülne" };
  let kind = "ending", stripeNote = null;
  if (stripe && u.stripeCustomerId) {
    try {
      const sub = await liveSub(u.stripeCustomerId);
      if (sub && !sub.cancel_at_period_end && !sub.cancel_at) {
        const ts = Math.floor(end.getTime() / 1000);
        const upd = await stripe.subscriptions.update(sub.id, { trial_end: ts, proration_behavior: "none" });
        const stripeEnd = new Date((upd.trial_end || upd.current_period_end || ts) * 1000).toISOString();
        usersDb.update(u.id, { paidUntil: stripeEnd, currentPeriodEnd: stripeEnd, subscriptionStatus: "active",
          stripeSubscriptionId: sub.id, extendedUntil: null });
        return { ok: true, email: u.email, kind: "renewing", newEnd: stripeEnd, stripe: true };
      }
      stripeNote = sub ? "lemondott – csak nálunk hosszabbítva, a Stripe nem terhel újra" : "nincs élő Stripe-előfizetés – csak nálunk hosszabbítva";
    } catch (e) {
      console.error(`Stripe hosszabbítási hiba (${u.email}):`, e.message);
      stripeNote = `Stripe hiba (${e.message}) – csak nálunk hosszabbítva, a terhelés NEM tolódott el`;
    }
  }
  const iso = end.toISOString();
  usersDb.update(u.id, { paidUntil: iso, currentPeriodEnd: iso, subscriptionStatus: "active", extendedUntil: u.stripeCustomerId ? iso : null });
  return { ok: true, email: u.email, kind, newEnd: iso, note: stripeNote };
}

// body: { days, userId? (egy tag; nélküle minden aktív előfizető), includeTrials?, notify?, reason?, dryRun? }
router.post("/api/admin/extend-subscriptions", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const days = parseInt(req.body?.days, 10);
  if (!days || Math.abs(days) > 90) return res.status(400).json({ error: "A napok száma -90 és 90 között legyen (0 nem lehet)." });
  const reason = String(req.body?.reason || "").trim().slice(0, 200);
  const notify = !!req.body?.notify && days > 0;
  const now = new Date();
  const all = usersDb.all().map(u => usersDb.findById(u.id)).filter(u => u && !u.isAdmin && !u.disabled);
  const isPayer = u => u.plan === "pro" && (!u.paidUntil || new Date(u.paidUntil) > now);
  const isTrial = u => u.plan !== "pro" && u.trialEndsAt && new Date(u.trialEndsAt) > now;
  let targets;
  if (req.body?.userId) {
    const u = all.find(x => x.id === req.body.userId);
    if (!u) return res.status(404).json({ error: "Nincs ilyen (aktív) tag." });
    if (!isPayer(u) && !isTrial(u)) return res.status(400).json({ error: "Ennek a tagnak nincs futó előfizetése vagy próbaideje." });
    targets = [u];
  } else {
    targets = all.filter(u => isPayer(u) || (req.body?.includeTrials && isTrial(u)));
  }
  if (req.body?.dryRun) return res.json({ ok: true, dryRun: true, count: targets.length,
    payers: targets.filter(isPayer).length, trials: targets.filter(isTrial).length,
    stripe: targets.filter(u => isPayer(u) && u.stripeCustomerId).length });

  const results = [];
  for (const u of targets) results.push(await extendOne(u, days));
  const ok = results.filter(r => r.ok);
  let mailed = 0, mailSkipped = 0;
  if (notify) {
    for (const r of ok) {
      const m = await mailer.sendSubscriptionExtended(r.email, days, r.newEnd, reason, r.kind).catch(() => ({ ok: false }));
      if (m && m.ok) mailed++; else mailSkipped++;
    }
  }
  const sign = days > 0 ? "+" : "";
  console.log(`Kézi lejárat-módosítás: ${sign}${days} nap, ${ok.length}/${results.length} tag (${ok.filter(r => r.stripe).length} Stripe-ban is)`);
  results.filter(r => !r.ok || r.note).forEach(r => console.log(`  ${r.email}: ${r.error || r.note}`));
  notifyAdmin(`📅 <b>Lejárat módosítva: ${sign}${days} nap</b>\n${ok.length} tag` +
    (targets.length === 1 ? ` (${esc(targets[0].email)})` : "") +
    (ok.some(r => r.stripe) ? ` · ${ok.filter(r => r.stripe).length} Stripe-ban is eltolva` : "") +
    (notify ? ` · e-mail: ${mailed}${mailSkipped ? ` (${mailSkipped} nem ment ki)` : ""}` : "") +
    (reason ? `\nOk: ${esc(reason)}` : ""));
  res.json({ ok: true, days, count: ok.length, failed: results.filter(r => !r.ok), notes: results.filter(r => r.ok && r.note),
    stripe: ok.filter(r => r.stripe).length, mailed, mailSkipped, results });
});

module.exports = { webhook, router };
