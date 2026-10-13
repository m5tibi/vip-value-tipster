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
// ── Valódi kliens IP ──────────────────────────────────────
// A Render előtt Cloudflare áll: a req.ip (trust proxy 1) a Cloudflare-szerver címe, ami minden
// látogatónál ugyanaz lehet. A Cloudflare a valódi címet a CF-Connecting-IP / True-Client-IP
// fejlécben adja (ezeket felülírja, így a kliens nem hamisíthatja); ha nincs ilyen, marad a req.ip.
let _ipLogged = false;
function clientIp(req) {
  const h = req.headers || {};
  const ip = String(h["cf-connecting-ip"] || h["true-client-ip"] || req.ip || "").trim() || "?";
  if (!_ipLogged && req.path && req.path.startsWith("/api/")) {
    _ipLogged = true;
    console.log(`Kliens IP forrás: ${h["cf-connecting-ip"] ? "CF-Connecting-IP" : h["true-client-ip"] ? "True-Client-IP" : "req.ip (nincs Cloudflare fejléc)"}`);
  }
  return ip;
}

function rateLimit(name, max, windowMs) {
  const c = hitCounter(max, windowMs);
  return (req, res, next) => {
    const key = clientIp(req);
    if (c.blocked(key)) {
      console.warn(`Rate limit (${name}): ${key}`);
      return res.status(429).json({ error: "Túl sok próbálkozás. Próbáld újra később." });
    }
    c.hit(key);
    next();
  };
}

module.exports = { safeOut, safeJson, hitCounter, rateLimit, clientIp };
