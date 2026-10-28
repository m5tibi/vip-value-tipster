// ── Hibás AI JSON javítása ──────────────────────────────────
// Az AI néha szabálytalan JSON-t ad: a szövegben (pl. az indoklásban) idézőjelet ("…")
// escape nélkül, sortörést a szövegen belül, vagy záró vesszőt ("…",} ). Egy ilyen hiba miatt
// eddig az egész futás (több perc, ~$0,6) kárba ment. Itt karakterenként végigmegyünk:
// - szövegen belüli " → \" , ha utána nem a JSON-szerkezet folytatódik (, } ] :)
// - szövegen belüli sortörés / tab → \n / \t
// - szövegen kívüli záró vessző (}, ] előtt) → törölve
function repairJson(src) {
  let out = "", inStr = false, esc = false;
  const skipWs = i => { while (i < src.length && /\s/.test(src[i])) i++; return i; };
  const nextNonWs = i => src[skipWs(i)];
  // Valóban a szöveg vége-e ez az idézőjel? Utána a JSON-szerkezetnek kell folytatódnia:
  // } ] : vagy a fájl vége – vessző esetén pedig a vessző után egy új JSON-elemnek ("kulcs", {, [, szám, true/false/null).
  const closesString = i => {
    const j = skipWs(i + 1), n = src[j];
    if (n === undefined || n === "}" || n === "]" || n === ":") return true;
    if (n !== ",") return false;
    const k = skipWs(j + 1), m = src[k];
    return m === undefined || /["{\[\]}\d-]/.test(m) || /^(true|false|null)\b/.test(src.slice(k, k + 5));
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) { out += c; esc = false; continue; }
      if (c === "\\") { out += c; esc = true; continue; }
      if (c === '"') {
        if (closesString(i)) { out += c; inStr = false; }
        else out += '\\"';                      // a szöveg része, nem a vége
        continue;
      }
      if (c === "\n") { out += "\\n"; continue; }
      if (c === "\r") continue;
      if (c === "\t") { out += "\\t"; continue; }
      out += c;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ",") { const n = nextNonWs(i + 1); if (n === "}" || n === "]") continue; }
    out += c;
  }
  return out;
}

// JSON.parse, és ha nem sikerül, javítás után még egyszer. Visszatér: { obj, repaired } vagy { error }
function parseLenient(src) {
  try { return { obj: JSON.parse(src), repaired: false }; } catch (e1) {
    try { return { obj: JSON.parse(repairJson(src)), repaired: true }; }
    catch (e2) { return { error: e1.message }; }
  }
}

module.exports = { repairJson, parseLenient };
