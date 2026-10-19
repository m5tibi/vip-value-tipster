// Közös beállítások (környezeti változókból)
const BASE_URL = (process.env.BASE_URL || "https://90perc.hu").replace(/\/$/, "");

// A publikus Telegram-csatorna meghívó linkje – minden oldal és üzenet ezt használja
const TG_PUBLIC_LINK = (process.env.TG_PUBLIC_LINK || "https://t.me/+DHhLxcVboA8yOTI0").trim();

module.exports = { BASE_URL, TG_PUBLIC_LINK };
