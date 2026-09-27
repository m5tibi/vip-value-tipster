// Közös beállítások (környezeti változókból)
const BASE_URL = (process.env.BASE_URL || "https://90perc.hu").replace(/\/$/, "");

module.exports = { BASE_URL };
