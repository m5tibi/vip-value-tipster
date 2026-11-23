// ── Hibás AI JSON javítása ──────────────────────────────────
// Az AI néha szabálytalan JSON-t ad: a szövegben (pl. az indoklásban) idézőjelet ("…")
// escape nélkül, sortörést a szövegen belül, vagy záró vesszőt ("…",} ). Egy ilyen hiba miatt
// az egész futás (több perc, ~$0,8) kárba megy. Itt karakterenként végigmegyünk, és követjük a
// JSON-szerkezetet (objektum / lista, kulcs / érték):
// - szövegen belüli " → \" , ha utána NEM folytatódhat szabályosan a JSON. Egy érték-szöveg vége
//   után csak ez jöhet: } vagy ] (a megfelelő zárójel), vagy vessző és utána objektumban egy új
//   "kulcs":, listában egy új érték. Egy kulcs vége után csak kettőspont.
//   Így az indoklásban lévő  a "Több mint 2,5", "BTTS" piacok  vagy  a "2,5", 3 meccsből  sem
//   zárja le idő előtt a szöveget.
// - szövegen belüli sortörés / tab → \n / \t
// - szövegen kívüli záró vessző (}, ] előtt) → törölve
const KEY_AHEAD = /^"(?:[^"\\\n]|\\.){1,80}"\s*:/;
const VALUE_START = /^(?:["{\[\-\d]|true\b|false\b|null\b)/;

function repairJson(src) {
  const skipWs = i => { while (i < src.length && /\s/.test(src[i])) i++; return i; };

  // A j. pozíciótól (egy lezárt érték után) szabályosan folytatódhat-e a JSON a megadott verem mellett?
  function validAfterValue(j, stack, depth = 0) {
    j = skipWs(j);
    const c = src[j], top = stack[stack.length - 1];
    if (c === undefined) return true;                                   // vége (csonka válasz is lehet)
    if (c === ",") {
      const rest = src.slice(skipWs(j + 1), skipWs(j + 1) + 100);
      if (top === "{") return KEY_AHEAD.test(rest);
      if (top === "[") return (VALUE_START.test(rest) && !KEY_AHEAD.test(rest)) || /^[\]}]/.test(rest);   // listában nincs "kulcs":
      return false;
    }
    if (c === "}" || c === "]") {
      if (top !== (c === "}" ? "{" : "[")) return false;
      if (depth >= 3) return true;
      return validAfterValue(j + 1, stack.slice(0, -1), depth + 1);
    }
    return false;
  }

  let out = "", inStr = false, esc = false, strIsKey = false;
  const stack = [];          // "{" vagy "["
  let expectKey = false;     // objektumban: a következő szöveg kulcs-e

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) { out += c; esc = false; continue; }
      if (c === "\\") {
        // Érvénytelen escape (pl. \% ) → a fordított perjel maga is szöveg
        if (/["\\/bfnrtu]/.test(src[i + 1] || "")) { out += c; esc = true; } else out += "\\\\";
        continue;
      }
      if (c === '"') {
        const closes = strIsKey ? src[skipWs(i + 1)] === ":" : validAfterValue(i + 1, stack);
        if (closes) { out += c; inStr = false; if (!strIsKey) expectKey = false; }
        else out += '\\"';                      // a szöveg része, nem a vége
        continue;
      }
      if (c === "\n") { out += "\\n"; continue; }
      if (c === "\r") continue;
      if (c === "\t") { out += "\\t"; continue; }
      out += c;
      continue;
    }
    if (c === '"') {
      inStr = true;
      strIsKey = stack[stack.length - 1] === "{" && expectKey;
      out += c;
      continue;
    }
    if (c === "{") { stack.push("{"); expectKey = true; out += c; continue; }
    if (c === "[") { stack.push("["); expectKey = false; out += c; continue; }
    if (c === "}" || c === "]") { stack.pop(); expectKey = false; out += c; continue; }
    if (c === ":") { expectKey = false; out += c; continue; }
    if (c === ",") {
      const n = src[skipWs(i + 1)];
      if (n === "}" || n === "]") continue;       // záró vessző
      expectKey = stack[stack.length - 1] === "{";
      out += c;
      continue;
    }
    out += c;
  }
  return out;
}

// A hiba helye körüli részlet (naplózáshoz)
function errorContext(src, message, radius = 120) {
  const m = /position (\d+)/.exec(message || "");
  if (!m) return "";
  const p = parseInt(m[1], 10);
  return src.slice(Math.max(0, p - radius), p) + " ⟪ITT⟫ " + src.slice(p, p + radius);
}

// JSON.parse, és ha nem sikerül, javítás után még egyszer.
// Visszatér: { obj, repaired } vagy { error, repairError, context }
function parseLenient(src) {
  try { return { obj: JSON.parse(src), repaired: false }; } catch (e1) {
    const fixed = repairJson(src);
    try { return { obj: JSON.parse(fixed), repaired: true }; }
    catch (e2) { return { error: e1.message, repairError: e2.message, context: errorContext(fixed, e2.message) }; }
  }
}

module.exports = { repairJson, parseLenient };
