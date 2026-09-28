// ── Admin értesítés Telegramon (privát chat) ─────────────────
// Előfizetési és regisztrációs eseményekről. Hiba esetén csak naplóz – az értesítés
// sikertelensége soha nem akaszthatja meg a fizetés/regisztráció feldolgozását.
const fetch   = require("node-fetch");
const usersDb = require("../users");

const TG_BOT_TOKEN       = process.env.TG_BOT_TOKEN;
const TG_PRIVATE_CHAT_ID = process.env.TG_PRIVATE_CHAT_ID || "1326707238"; // admin privát (mint a server.js-ben)

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const huDate = iso => iso ? new Date(iso).toLocaleDateString("hu-HU", { timeZone: "Europe/Budapest" }) : "–";
const activeSubscribers = () => usersDb.all().filter(u => u.plan === "pro" && !u.isAdmin).length;

async function notifyAdmin(html) {
  if (!TG_BOT_TOKEN || !TG_PRIVATE_CHAT_ID) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_PRIVATE_CHAT_ID, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) console.error("Admin Telegram értesítés hiba:", JSON.stringify(d));
  } catch (e) {
    console.error("Admin Telegram értesítés hiba:", e.message);
  }
}

module.exports = { notifyAdmin, esc, huDate, activeSubscribers };
