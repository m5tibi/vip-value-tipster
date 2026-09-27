// ── XSS-védelem ───────────────────────────────────────────
// A frontend innerHTML-lel rajzol, a szövegek pedig részben az AI-tól (webes keresésből)
// és a felhasználóktól (e-mail cím) jönnek. Ezért minden kimenő JSON szöveges mezőjében
// a < és > jeleket ártalmatlan, hasonló kinézetű jelekre cseréljük – így HTML tag nem kerülhet be.
// (Adat HTML-attribútumba / onclick-be nem kerül, csak azonosító – ezt a frontenden tartsuk is így.)
function safeOut(v) {
  if (typeof v === "string") return v.replace(/</g, "‹").replace(/>/g, "›");
  if (Array.isArray(v)) return v.map(safeOut);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = safeOut(v[k]);
    return o;
  }
  return v;
}
function safeJson(req, res, next) {
  const json = res.json.bind(res);
  res.json = body => json(safeOut(body));
  next();
}

// ── Próbálkozás-korlátozás (brute force / spam ellen) ─────
// Egyszerű, memóriában tartott csúszóablakos számláló IP-nként – egy példányhoz elég.
function hitCounter(max, windowMs) {
  const hits = new Map();
  const recent = key => (hits.get(key) || []).filter(t => Date.now() - t < windowMs);
  setInterval(() => {
    for (const k of hits.keys()) {
      const fresh = recent(k);
      if (fresh.length) hits.set(k, fresh); else hits.delete(k);
    }
  }, windowMs).unref();
  return {
    blocked: key => recent(key).length >= max,
    hit:     key => hits.set(key, [...recent(key), Date.now()]),
  };
}
function rateLimit(name, max, windowMs) {
  const c = hitCounter(max, windowMs);
  return (req, res, next) => {
    const key = req.ip || "?";
    if (c.blocked(key)) {
      console.warn(`Rate limit (${name}): ${key}`);
      return res.status(429).json({ error: "Túl sok próbálkozás. Próbáld újra később." });
    }
    c.hit(key);
    next();
  };
}

module.exports = { safeOut, safeJson, hitCounter, rateLimit };
