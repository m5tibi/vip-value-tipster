// ── TELEGRAM BOT (kétirányú) ──────────────────────────────
// A tippeket a server.js tartja memóriában, ezért getHistory()/isApproved kívülről jön.
const express = require("express");
const fetch   = require("node-fetch");
const { BASE_URL } = require("../lib/config");

const TG_BOT_TOKEN  = process.env.TG_BOT_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

module.exports = function createTelegramBot({ getHistory, isApproved }) {
  const router = express.Router();
  const TG_BOT_API = `https://api.telegram.org/bot${TG_BOT_TOKEN}`;

  async function tgSend(chatId, text, extra = {}) {
    if (!TG_BOT_TOKEN) return;
    await fetch(`${TG_BOT_API}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...extra })
    }).catch(e => console.error("tgSend hiba:", e.message));
  }

  // Telegram HTML módhoz: felhasználói szöveg escape-elése
  const tgEsc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  async function tgTyping(chatId) {
    if (!TG_BOT_TOKEN) return;
    await fetch(`${TG_BOT_API}/sendChatAction`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" })
    }).catch(() => {});
  }

  // ── Meccs elemzés szerver oldalon (bot számára) ───────────────
  async function analyzeForBot(query) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "anthropic-beta": "web-search-2025-03-05" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 4000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content:
          `Te egy profi labdarúgás-fogadási elemző vagy. Kizárólag helyes, igényes magyar nyelven írj. Kerüld a zsargont.

A kérés: "${query}"

Ha nem focimeccs, válaszolj: "NEM ÉRTEM: [magyarázat]"

Készíts rövid, tömör elemzést Telegram-ra optimalizálva (max 800 karakter). Struktúra:

⚽ <b>[Meccs neve]</b>

<b>Forma:</b> [1-2 mondat, számokkal]
<b>H2H:</b> [1 mondat]
<b>Sérülések:</b> [1 mondat]

<b>Top tippek:</b>
1. [Tipp] @ [odds] – [Megbízhatóság: MAGAS/KÖZEPES]
2. [Tipp] @ [odds] – [Megbízhatóság: MAGAS/KÖZEPES]

Ne használj csillagot (*) vagy hashtaget (#). Csak HTML bold (<b>) formázást.`
        }]
      })
    });
    const data = await r.json();
    const text = (data.content?.filter(b => b.type === "text").map(b => b.text) || []).join("\n").trim();
    return text || "Az elemzés sikertelen. Próbáld újra.";
  }

  // ── Bot parancsok kezelése ────────────────────────────────────
  async function handleBotUpdate(update) {
    const msg    = update.message || update.edited_message;
    if (!msg?.text) return;
    if (msg.chat.type !== "private") return;  // csak privát chat, ne csatorna/csoport
    const chatId = msg.chat.id;
    const text   = msg.text.trim();
    const userId = msg.from?.id;

    // /start
    if (text === "/start" || text.startsWith("/start ")) {
      await tgSend(chatId,
        `⚽ <b>Üdv a 90perc.hu botban!</b>\n\n` +
        `<b>Parancsok:</b>\n` +
        `/tippek – A mai ingyenes tipp\n` +
        `/help – Súgó\n\n` +
        `<a href="https://90perc.hu">90perc.hu →</a>`
      );
      return;
    }

    // /help
    if (text === "/help") {
      await tgSend(chatId,
        `<b>90perc.hu Bot – Súgó</b>\n\n` +
        `/tippek – Megmutatja a mai ingyenes tippet\n\n` +
        `A többi napi tipp előfizetőknek a weboldalon érhető el:\n` +
        `<a href="https://90perc.hu/elofizetes.html">Pro előfizetés →</a>`
      );
      return;
    }

    // /tippek – csak az ingyenes tipp: a fizetős tippek előfizetőknek szólnak, a bot pedig bárkinek válaszol
    if (text === "/tippek") {
      const free = getHistory().filter(t =>
        t.type === "free" && isApproved(t) && (!t.result || t.result === "pending")
      );
      if (!free.length) {
        await tgSend(chatId, "⚽ Ma még nincs ingyenes tipp. Nézz vissza később!");
        return;
      }
      const lines = free.slice(0, 3).map(t => t.legs?.length
        ? `• <b>Kombi</b> @ ${tgEsc(t.odds)}\n` + t.legs.map(l => `  – ${tgEsc(l.match)}: <b>${tgEsc(l.pick)}</b> @ ${tgEsc(l.odds)}`).join("\n")
        : `• <b>${tgEsc(t.match)}</b>\n  ${tgEsc(t.market)}: <b>${tgEsc(t.pick)}</b> @ ${tgEsc(t.odds)}`
      ).join("\n\n");
      await tgSend(chatId,
        `🆓 <b>Mai ingyenes tipp</b>\n\n${lines}\n\n` +
        `<a href="https://90perc.hu/elofizetes.html">Összes napi tipp – Pro előfizetés →</a>`
      );
      return;
    }


    // /elemzes
    if (text.startsWith("/elemzes")) {
      // Csak az adminnak (ADMIN_TELEGRAM_CHAT_ID) – előfizetőknek nem szolgáltatás
      const ADMIN_TG_ID = process.env.ADMIN_TELEGRAM_CHAT_ID;
      if (!ADMIN_TG_ID || String(chatId) !== String(ADMIN_TG_ID)) {
        await tgSend(chatId, "❓ Ismeretlen parancs. Írd: /help");
        return;
      }
      const query = text.replace("/elemzes", "").trim();
      if (!query) {
        await tgSend(chatId, "❓ Add meg a meccs nevét!\nPélda: <code>/elemzes Bayern - Dortmund</code>");
        return;
      }

      await tgSend(chatId, `🔍 Elemzem: <b>${tgEsc(query)}</b>...\nEz 30-60 másodpercig tarthat.`);
      // Folyamatos "typing" jelzés amíg az AI dolgozik
      const typingInterval = setInterval(() => tgTyping(chatId), 4000);
      try {
        const result = await analyzeForBot(query);
        clearInterval(typingInterval);
        // Telegram max 4096 karakter
        const chunks = result.match(/.{1,4000}/gs) || [result];
        for (const chunk of chunks) await tgSend(chatId, chunk);
      } catch(e) {
        clearInterval(typingInterval);
        console.error("Bot elemzés hiba:", e.message);
        await tgSend(chatId, "❌ Elemzési hiba. Próbáld újra néhány perc múlva.");
      }
      return;
    }

    // Ismeretlen parancs
    if (text.startsWith("/")) {
      await tgSend(chatId, "❓ Ismeretlen parancs. Írd: /help");
    }
  }

  // ── Telegram bot webhook endpoint ─────────────────────────────
  // Telegram GET-tel is ellenőrzi a webhookot
  router.get("/api/telegram/bot", (req, res) => res.sendStatus(200));

  // TG_WEBHOOK_SECRET: a Telegram minden hívásnál visszaküldi az X-Telegram-Bot-Api-Secret-Token
  // headerben – enélkül bárki hamisíthatna bot-üzenetet (pl. admin chat ID nevében).
  const TG_WEBHOOK_SECRET = process.env.TG_WEBHOOK_SECRET;
  router.post("/api/telegram/bot", async (req, res) => {
    if (!TG_WEBHOOK_SECRET || req.get("x-telegram-bot-api-secret-token") !== TG_WEBHOOK_SECRET) {
      return res.sendStatus(403);
    }
    res.sendStatus(200); // Telegram-nak azonnal válaszolunk
    try { await handleBotUpdate(req.body); } catch(e) { console.error("Bot hiba:", e.message); }
  });


  // Induláskor: webhook (újra)regisztrálása
  function registerWebhook() {
  if (TG_BOT_TOKEN) {
    if (TG_WEBHOOK_SECRET) {
      // Webhook (újra)regisztrálása a secret tokennel – így elég a TG_WEBHOOK_SECRET env változót beállítani
      fetch(`${TG_BOT_API}/setWebhook`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `${BASE_URL}/api/telegram/bot`, secret_token: TG_WEBHOOK_SECRET }),
      }).then(r => r.json())
        .then(d => console.log(d.ok ? "✓ Telegram bot aktív – webhook: /api/telegram/bot" : `⚠️  Telegram setWebhook hiba: ${d.description}`))
        .catch(e => console.error("Telegram setWebhook hiba:", e.message));
    } else {
      console.warn("⚠️  TG_WEBHOOK_SECRET nincs beállítva – a Telegram bot parancsai le vannak tiltva. Állítsd be a Renderen (A-Z, a-z, 0-9, _ és -, max. 256 karakter).");
    }
  } else {
    console.log("⚠️  TG_BOT_TOKEN nincs beállítva – bot inaktív");
  }
  }

  return { router, registerWebhook };
};
