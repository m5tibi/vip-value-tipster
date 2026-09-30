// ── Claude hívás webes kereséssel (tippgenerálás, Telegram /elemzes) ──
// - web_search_20260209: a keresési találatokat a modell elolvasása előtt szűri (dinamikus
//   szűrés), így kevesebb bemeneti token kell; max_uses korlátozza a keresések számát.
// - pause_turn: hosszabb szerveroldali keresési sorozatnál az API félbehagyott választ ad,
//   ilyenkor az eddigi tartalommal visszaküldve folytatjuk.
// - Prompt caching: a (hosszú) prompt gyorsítótárazva megy, mert minden keresés után újra
//   beolvasódik – a gyorsítótárból olvasott rész az alapár kb. tizedébe kerül.
// - Minden hívás után egy költségsor megy a logba (tokenek, gyorsítótár, keresések, becsült költség).
const fetch = require("node-fetch");

const MODEL = "claude-sonnet-4-6";
const PRICE_PER_MTOK = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };   // Sonnet 4.6, USD / 1M token
const MAX_CONTINUATIONS = 5;
// Egy API-kérés legfeljebb ennyi ideig tarthat: időkorlát nélkül egy elakadt kapcsolat
// örökre várakoztatná a tippgenerálást (a log az "AI elemzés: N meccs" sornál megállna).
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

async function callClaudeWithSearch({ apiKey, prompt, maxTokens, maxSearches, label }) {
  const messages = [{ role: "user", content: [{ type: "text", text: prompt, cache_control: { type: "ephemeral" } }] }];
  const content = [];                 // az összes visszakapott blokk (folytatásokkal együtt)
  const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, searches: 0 };
  let data = null;
  const started = Date.now();
  const secs = () => Math.round((Date.now() - started) / 1000);
  console.log(`[${label}] Claude hívás indul (legfeljebb ${maxSearches} keresés)…`);

  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: MODEL, max_tokens: maxTokens,
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: maxSearches }],
          messages: i === 0 ? messages : [...messages, { role: "assistant", content }],
        }),
      });
      data = await r.json();
    } catch (e) {
      const msg = e.name === "AbortError" ? `időtúllépés (${REQUEST_TIMEOUT_MS / 60000} perc)` : e.message;
      console.error(`[${label}] Claude hívás sikertelen ${secs()} mp után: ${msg}`);
      return { error: { type: "request_failed", message: msg }, text: "", stopReason: null, usage };
    } finally { clearTimeout(timer); }
    if (data.error) {
      console.error(`[${label}] Claude API hiba ${secs()} mp után: ${data.error.type} – ${data.error.message}`);
      return { error: data.error, text: "", stopReason: null, usage };
    }

    content.push(...(data.content || []));
    usage.input    += data.usage?.input_tokens || 0;
    usage.output   += data.usage?.output_tokens || 0;
    usage.cacheWrite += data.usage?.cache_creation_input_tokens || 0;
    usage.cacheRead  += data.usage?.cache_read_input_tokens || 0;
    usage.searches += data.usage?.server_tool_use?.web_search_requests || 0;
    if (data.stop_reason !== "pause_turn") break;
    console.log(`[${label}] pause_turn – folytatás (${i + 1}.)`);
  }

  const cost = (usage.input * PRICE_PER_MTOK.input + usage.output * PRICE_PER_MTOK.output +
    usage.cacheWrite * PRICE_PER_MTOK.cacheWrite + usage.cacheRead * PRICE_PER_MTOK.cacheRead) / 1e6;
  console.log(`[AI költség] ${label}: ${usage.input} bemeneti + ${usage.output} kimeneti token, ` +
    `gyorsítótár: ${usage.cacheWrite} írás / ${usage.cacheRead} olvasás, ` +
    `${usage.searches} keresés, ${secs()} mp · token-költség ≈ $${cost.toFixed(3)} (a keresések díja ezen felül)`);

  // A kész válasz az utolsó eszközhasználat utáni szöveg; az előtte lévő szövegblokkok
  // a keresés közbeni megjegyzések. Ha nincs ilyen, az összes szöveget visszaadjuk.
  let lastTool = -1;
  content.forEach((b, i) => { if (b.type !== "text") lastTool = i; });
  const pick = blocks => blocks.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  const text = pick(content.slice(lastTool + 1)) || pick(content);
  return { text, stopReason: data?.stop_reason || null, usage };
}

module.exports = { callClaudeWithSearch };
