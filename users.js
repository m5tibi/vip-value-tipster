// ── Felhasználó-tár ───────────────────────────────────────
// JSON fájl a perzisztens /data lemezen, ATOMI írással (temp fájl + rename),
// hogy egy megszakadt írás ne tegye tönkre az adatbázist.
// Az interfész szándékosan egyszerű – később Postgres-re cserélhető anélkül,
// hogy a server.js-t át kellene írni.

const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const DATA_DIR   = process.env.DATA_DIR || "/data";
const USERS_FILE = path.join(DATA_DIR, "users.json");

let users = [];        // memóriában tartjuk (kis adatmennyiség, gyors olvasás)

function load() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(USERS_FILE)) { users = []; return; }
    users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")) || [];
  } catch (e) {
    console.error("users.json betöltési hiba:", e.message);
    users = [];
  }
}

function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = USERS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
    fs.renameSync(tmp, USERS_FILE);          // atomi csere
  } catch (e) {
    console.error("users.json mentési hiba:", e.message);
  }
}

const normEmail = e => String(e || "").trim().toLowerCase();

function findByEmail(email) {
  const e = normEmail(email);
  return users.find(u => u.email === e) || null;
}
function findById(id) {
  return users.find(u => u.id === id) || null;
}
function findByStripeCustomer(cid) {
  return users.find(u => u.stripeCustomerId === cid) || null;
}

// Új felhasználó. Visszatér: { ok, user } vagy { ok:false, error }
// A skipPolicy csak a belső admin-bootstraphez való (a meglévő ADMIN_PASSWORD lehet rövidebb).
async function create(email, password, { isAdmin = false, skipPolicy = false } = {}) {
  const e = normEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { ok: false, error: "Érvénytelen e-mail cím." };
  if (!password)                             return { ok: false, error: "A jelszó kötelező." };
  if (!skipPolicy && password.length < 8)    return { ok: false, error: "A jelszó legalább 8 karakter legyen." };
  if (findByEmail(e))                        return { ok: false, error: "Ezzel az e-mail címmel már van fiók." };

  const user = {
    id: crypto.randomUUID(),
    email: e,
    passwordHash: await bcrypt.hash(password, 10),
    isAdmin,
    emailVerified: !!isAdmin,     // az admin fiók eleve megerősítettnek számít
    plan: "free",                 // "free" | "pro"
    // Stripe mezők – most üresek, a fizetőssé tételkor töltődnek
    stripeCustomerId: null,
    subscriptionId: null,
    subscriptionStatus: null,     // "active" | "past_due" | "canceled" ...
    currentPeriodEnd: null,       // ISO dátum
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };
  users.push(user);
  save();
  return { ok: true, user };
}

async function verify(email, password) {
  const u = findByEmail(email);
  if (!u) return null;
  const ok = await bcrypt.compare(String(password || ""), u.passwordHash);
  if (!ok) return null;
  u.lastLoginAt = new Date().toISOString();
  save();
  return u;
}

// Részleges frissítés (pl. Stripe adatok webhookból)
function update(id, patch) {
  const u = findById(id);
  if (!u) return null;
  Object.assign(u, patch);
  save();
  return u;
}

async function setPassword(id, newPassword) {
  if (!newPassword || newPassword.length < 8) return { ok: false, error: "A jelszó legalább 8 karakter legyen." };
  const u = findById(id);
  if (!u) return { ok: false, error: "Nincs ilyen felhasználó." };
  u.passwordHash = await bcrypt.hash(newPassword, 10);
  save();
  return { ok: true };
}

// Kifelé SOHA ne menjen jelszó-hash
function publicView(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, isAdmin: !!u.isAdmin, plan: u.plan,
    emailVerified: u.emailVerified !== false,   // régi fiókok visszafelé kompatibilisen megerősítettek
    subscriptionStatus: u.subscriptionStatus, currentPeriodEnd: u.currentPeriodEnd,
    createdAt: u.createdAt,
  };
}

const count = () => users.length;
const all   = () => users.map(publicView);

load();

module.exports = {
  findByEmail, findById, findByStripeCustomer,
  create, verify, update, setPassword,
  publicView, count, all,
};
