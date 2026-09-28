// ── Felhasználói fiók végpontok: regisztráció, belépés, jelszó ──
const express = require("express");
const usersDb = require("../users");
const auth    = require("../auth");
const mailer  = require("../mailer");
const { BASE_URL }   = require("../lib/config");
const { rateLimit }  = require("../lib/security");
const { isAdminReq } = require("../lib/admin");
const { notifyAdmin, esc } = require("../lib/notify");

const router = express.Router();

const loginLimiter = rateLimit("login", 10, 15 * 60 * 1000);   // 10 próbálkozás / 15 perc
const mailLimiter  = rateLimit("mail",   5, 60 * 60 * 1000);   // jelszó-visszaállítás / újraküldés: 5 / óra
const regLimiter   = rateLimit("register", 20, 60 * 60 * 1000); // regisztráció: 20 / óra (mobilhálózaton sokan osztoznak egy IP-n)

// ── Auth végpontok ────────────────────────────────────────
const baseUrl = req => BASE_URL || `${req.protocol}://${req.get("host")}`;

async function sendVerifyEmail(req, user) {
  const token = auth.makePurposeToken("verify", user.id, 24 * 3600 * 1000);
  const url   = `${baseUrl(req)}/api/auth/verify?token=${encodeURIComponent(token)}`;
  return mailer.sendVerification(user.email, url);
}

router.post("/api/auth/register", regLimiter, async (req, res) => {
  const { email, password, acceptTerms, over18 } = req.body || {};
  if (!acceptTerms || !over18) {
    return res.status(400).json({ error: "El kell fogadnod az ÁSZF-et és nyilatkoznod kell a 18. életéved betöltéséről." });
  }
  const r = await usersDb.create(email, password);
  if (!r.ok) return res.status(400).json({ error: r.error });
  usersDb.update(r.user.id, { acceptedTermsAt: new Date().toISOString() });
  auth.setSession(res, r.user.id);
  sendVerifyEmail(req, r.user).catch(() => {});     // ne blokkolja a választ
  console.log(`Új regisztráció: ${r.user.email} (összes: ${usersDb.count()})`);
  notifyAdmin(`👤 <b>Új regisztráció</b>\n${esc(r.user.email)}\nRegisztrált felhasználók: ${usersDb.count()}`);
  res.json({ ok: true, user: usersDb.publicView(r.user), hasAccess: auth.hasAccess(r.user) });
});

// E-mail megerősítés (a levélben lévő linkről érkezik – HTML választ adunk)
router.get("/api/auth/verify", (req, res) => {
  const uid = auth.readPurposeToken("verify", req.query.token);
  const page = (icon, title, msg, color) => `<!DOCTYPE html><html lang="hu"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#07111d;color:#cfd8dc;font-family:-apple-system,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px">
<div style="background:#0d1b2a;border:1px solid #1e3a2f;border-radius:12px;padding:28px;max-width:420px;text-align:center">
<div style="font-size:40px;margin-bottom:8px">${icon}</div>
<div style="color:${color};font-weight:700;font-size:18px;margin-bottom:8px">${title}</div>
<div style="color:#78909c;font-size:14px;line-height:1.6;margin-bottom:18px">${msg}</div>
<a href="/" style="display:inline-block;background:#00e676;color:#07111d;font-weight:700;padding:11px 22px;border-radius:8px;text-decoration:none">Tovább a tippekhez</a>
</div></body></html>`;
  if (!uid) {
    return res.status(400).send(page("⚠️", "Érvénytelen vagy lejárt link",
      "A megerősítő link lejárt (24 óráig érvényes) vagy érvénytelen. Lépj be, és kérj új megerősítő e-mailt.", "#ffcc80"));
  }
  const u = usersDb.findById(uid);
  if (!u) return res.status(400).send(page("⚠️", "Nincs ilyen fiók", "A fiók már nem létezik.", "#ffcc80"));
  usersDb.update(uid, { emailVerified: true });
  console.log(`E-mail megerősítve: ${u.email}`);
  res.send(page("✅", "E-mail cím megerősítve", "Köszönjük! A fiókod aktív, jó szórakozást.", "#00e676"));
});

router.post("/api/auth/resend-verification", auth.requireLogin, mailLimiter, async (req, res) => {
  if (req.user.emailVerified) return res.json({ ok: true, already: true });
  await sendVerifyEmail(req, req.user);
  res.json({ ok: true });
});

// Elfelejtett jelszó – MINDIG ok:true a válasz (nem áruljuk el, létezik-e a fiók)
router.post("/api/auth/forgot", mailLimiter, async (req, res) => {
  const u = usersDb.findByEmail(req.body?.email);
  if (u && !u.disabled) {
    // A hash a tokenben → a link egyszer használatos (jelszóváltáskor érvénytelenné válik)
    const token = auth.makePurposeToken("reset", u.id, 3600 * 1000, u.passwordHash);
    const url   = `${baseUrl(req)}/reset.html?token=${encodeURIComponent(token)}`;
    await mailer.sendPasswordReset(u.email, url);
    console.log(`Jelszó-visszaállítás kérve: ${u.email}`);
  }
  res.json({ ok: true });
});

router.post("/api/auth/reset", loginLimiter, async (req, res) => {
  const { token, newPassword } = req.body || {};
  const uid = auth.readPurposeToken("reset", token, id => usersDb.findById(id)?.passwordHash || "");
  if (!uid || usersDb.findById(uid)?.disabled) return res.status(400).json({ error: "A link érvénytelen vagy lejárt. Kérj újat." });
  const r = await usersDb.setPassword(uid, newPassword);
  if (!r.ok) return res.status(400).json({ error: r.error });
  const u = usersDb.findById(uid);
  usersDb.update(uid, { emailVerified: true });   // a linket csak az kaphatta meg, akié a postafiók
  auth.setSession(res, uid);                       // egyből be is léptetjük
  console.log(`Jelszó visszaállítva: ${u.email}`);
  res.json({ ok: true });
});

router.post("/api/auth/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const u = await usersDb.verify(email, password);
  if (!u) return res.status(401).json({ error: "Hibás e-mail cím vagy jelszó." });
  auth.setSession(res, u.id);
  res.json({ ok: true, user: usersDb.publicView(u), hasAccess: auth.hasAccess(u) });
});

router.post("/api/auth/logout", (req, res) => {
  auth.clearSession(res);
  res.json({ ok: true });
});

// Ki vagyok? (a frontend ezzel dönti el, mit mutasson)
router.get("/api/auth/me", (req, res) => {
  // Friss DB lookup – Stripe webhook utáni plan változás azonnal látszódjon
  const freshUser = req.user ? (usersDb.findById(req.user.id) || req.user) : req.user;
  res.json({
    user:      usersDb.publicView(freshUser),
    hasAccess: auth.hasAccess(freshUser),
    paidMode:  auth.PAID_MODE,
    isAdmin:   !!req.user?.isAdmin || isAdminReq(req),
  });
});

router.post("/api/auth/password", auth.requireLogin, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const ok = await usersDb.verify(req.user.email, currentPassword);
  if (!ok) return res.status(401).json({ error: "A jelenlegi jelszó hibás." });
  const r = await usersDb.setPassword(req.user.id, newPassword);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true });
});

module.exports = router;
