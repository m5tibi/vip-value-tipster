// ── Hitelesítés és jogosultság ────────────────────────────
// Session: aláírt (HMAC), httpOnly cookie – nincs szükség külső session-tárra.
// A cookie tartalma: {userId}.{lejárat}.{aláírás} – a szerver titkos kulcsával aláírva,
// így nem hamisítható, és a kliens nem tudja átírni.

const crypto = require("crypto");
const users  = require("./users");

const COOKIE     = "90perc_session";
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;         // 30 nap

// A SESSION_SECRET-et a Renderen állítsd be! Ha hiányzik, generálunk egyet,
// de akkor minden újraindításkor kiléptet mindenkit (figyelmeztetünk is).
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) {
  console.warn("⚠️  SESSION_SECRET nincs beállítva – a felhasználók minden újraindításkor kiléptetődnek. Állítsd be a Renderen!");
}

// Fizetős mód kapcsoló. false (alapértelmezett) = ingyenes szakasz: minden
// belépett felhasználó hozzáfér. true = csak aktív előfizető fér hozzá.
const PAID_MODE = String(process.env.PAID_MODE || "").toLowerCase() === "true";

const sign = data => crypto.createHmac("sha256", SECRET).update(data).digest("base64url");

function makeToken(userId) {
  const exp  = Date.now() + MAX_AGE_MS;
  const data = `${userId}.${exp}`;
  return `${data}.${sign(data)}`;
}

function readToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, exp, sig] = parts;
  const data = `${userId}.${exp}`;
  const expected = sign(data);
  // időzítés-biztos összehasonlítás
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Date.now() > Number(exp)) return null;       // lejárt
  return userId;
}

function setSession(res, userId) {
  res.cookie(COOKIE, makeToken(userId), {
    httpOnly: true,                                 // JS-ből nem olvasható (XSS-védelem)
    secure: process.env.NODE_ENV !== "development", // csak HTTPS-en (Renderen mindig)
    sameSite: "lax",                                // CSRF-védelem
    maxAge: MAX_AGE_MS,
    path: "/",
  });
}

function clearSession(res) {
  res.clearCookie(COOKIE, { path: "/" });
}

// Minden kérésre beteszi a req.user-t (ha van érvényes session)
function attachUser(req, res, next) {
  const uid = readToken(req.cookies?.[COOKIE]);
  req.user = uid ? users.findById(uid) : null;
  next();
}

// Hozzáférés a tippekhez:
//  - admin: mindig
//  - ingyenes szakasz (PAID_MODE=false): minden belépett felhasználó
//  - fizetős szakasz (PAID_MODE=true): csak aktív előfizető
function hasAccess(user) {
  if (!user) return false;
  if (user.isAdmin) return true;
  if (!PAID_MODE) return true;
  if (user.plan !== "pro") return false;
  if (!["active", "trialing"].includes(user.subscriptionStatus || "")) return false;
  if (user.currentPeriodEnd && new Date(user.currentPeriodEnd) < new Date()) return false;
  return true;
}

// Middleware: belépés kötelező
function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Belépés szükséges.", needLogin: true });
  next();
}

// Middleware: tippekhez való hozzáférés kötelező
function requireAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Belépés szükséges.", needLogin: true });
  if (!hasAccess(req.user)) {
    return res.status(402).json({ error: "Aktív előfizetés szükséges.", needSubscription: true });
  }
  next();
}

// ── Célhoz kötött tokenek (e-mail megerősítés, jelszó-visszaállítás) ──
// Aláírt, lejáró token – nem kell adatbázisban tárolni.
// A jelszó-hash beépítése miatt a reset link AUTOMATIKUSAN érvénytelenné válik,
// amint a jelszó megváltozik (egyszer használatos).
function makePurposeToken(purpose, userId, ttlMs, extra = "") {
  const exp  = Date.now() + ttlMs;
  const data = `${purpose}.${userId}.${exp}`;
  const sig  = crypto.createHmac("sha256", SECRET).update(data + "." + extra).digest("base64url");
  return `${Buffer.from(data).toString("base64url")}.${sig}`;
}

function readPurposeToken(purpose, token, extraFor) {
  try {
    if (!token || typeof token !== "string") return null;
    const [b64, sig] = token.split(".");
    if (!b64 || !sig) return null;
    const data = Buffer.from(b64, "base64url").toString("utf8");
    const [p, userId, exp] = data.split(".");
    if (p !== purpose) return null;
    if (Date.now() > Number(exp)) return null;
    const extra = typeof extraFor === "function" ? (extraFor(userId) || "") : "";
    const expected = crypto.createHmac("sha256", SECRET).update(data + "." + extra).digest("base64url");
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return userId;
  } catch { return null; }
}

module.exports = {
  COOKIE, PAID_MODE,
  setSession, clearSession, attachUser,
  hasAccess, requireLogin, requireAccess,
  makePurposeToken, readPurposeToken,
};
