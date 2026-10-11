// ── Claude hívás webes kereséssel (tippgenerálás, Telegram /elemzes) ──
// - web_search_20260209: a keresési találatokat a modell elolvasása előtt szűri (dinamikus
//   szűrés), így kevesebb bemeneti token kell; max_uses korlátozza a keresések számát.
// - pause_turn: hosszabb szerveroldali keresési sorozatnál az API félbehagyott választ ad,
//   ilyenkor az eddigi tartalommal visszaküldve folytatjuk.
// - Prompt caching: a (hosszú) prompt gyorsítótárazva megy, mert minden keresés után újra
//   beolvasódik – a gyorsítótárból olvasott rész az alapár kb. tizedébe kerül.
// - Streaming (hivatalos SDK): a hosszú hívás folyamatos eseményfolyam, tétlenségfigyeléssel.
// - Minden hívás után egy költségsor megy a logba (tokenek, gyorsítótár, keresések, becsült költség).
const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-sonnet-4-6";
const PRICE_PER_MTOK = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };   // Sonnet 4.6, USD / 1M token
const MAX_CONTINUATIONS = 5;
// Streaming: a hosszú (sok kereséses) hívás nem egyetlen, percekig néma HTTP-válasz, hanem
// folyamatos eseményfolyam. Időkorlát helyett tétlenséget figyelünk: ha IDLE_TIMEOUT_MS-ig
// egyetlen esemény sem jön, a kapcsolat elakadt → leállítjuk. A teljes hívásra van egy
// biztonsági felső korlát is (sok meccs + 12 keresés + hosszú JSON-válasz akár 10 percen túl is tarthat).
const IDLE_TIMEOUT_MS  = 3 * 60 * 1000;
const TOTAL_TIMEOUT_MS = 20 * 60 * 1000;

async function callClaudeWithSearch({ apiKey, prompt, maxTokens, maxSearches, label }) {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: TOTAL_TIMEOUT_MS });
  const messages = [{ role: "user", content: [{ type: "text", text: prompt, cache_control: { type: "ephemeral" } }] }];
  const content = [];                 // az összes visszakapott blokk (folytatásokkal együtt)
  const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, searches: 0 };
  let msg = null;
  const started = Date.now();
  const secs = () => Math.round((Date.now() - started) / 1000);
  let searchCount = 0, filterCount = 0;   // csak a naplózáshoz
  console.log(`[${label}] Claude hívás indul (legfeljebb ${maxSearches} keresés, streaming)…`);

  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const stream = client.messages.stream({
      model: MODEL, max_tokens: maxTokens,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: maxSearches }],
      // pause_turn után az eddigi válasz változatlanul visszamegy, a szerver onnan folytatja
      messages: i === 0 ? messages : [...messages, { role: "assistant", content }],
    });
    let reason = null, lastEvent = Date.now();
    stream.on("streamEvent", ev => {
      lastEvent = Date.now();
      // A web_search_20260209 a találatokat háttérben futó kóddal szűri – ezek is szerveroldali
      // eszközhívások, de nem keresések (a max_uses csak a keresést korlátozza)
      if (ev.type === "content_block_start" && ev.content_block?.type === "server_tool_use") {
        if (ev.content_block.name === "web_search") console.log(`[${label}] keresés ${++searchCount}. (${secs()} mp)`);
        else filterCount++;
      }
    });
    const watchdog = setInterval(() => {
      if (Date.now() - lastEvent > IDLE_TIMEOUT_MS) { reason = `nincs válasz ${IDLE_TIMEOUT_MS / 60000} perce`; stream.abort(); }
      else if (Date.now() - started > TOTAL_TIMEOUT_MS) { reason = `időtúllépés (${TOTAL_TIMEOUT_MS / 60000} perc)`; stream.abort(); }
    }, 5000);
    try {
      msg = await stream.finalMessage();
    } catch (e) {
      const message = reason || (e instanceof Anthropic.APIError ? `${e.status || ""} ${e.message}`.trim() : e.message);
      console.error(`[${label}] Claude hívás sikertelen ${secs()} mp után: ${message}`);
      const type = !reason && e instanceof Anthropic.APIError ? (e.error?.error?.type || "api_error") : "request_failed";
      return { error: { type, message }, text: "", stopReason: null, usage };
    } finally { clearInterval(watchdog); }

    content.push(...(msg.content || []));
    usage.input      += msg.usage?.input_tokens || 0;
    usage.output     += msg.usage?.output_tokens || 0;
    usage.cacheWrite += msg.usage?.cache_creation_input_tokens || 0;
    usage.cacheRead  += msg.usage?.cache_read_input_tokens || 0;
    usage.searches   += msg.usage?.server_tool_use?.web_search_requests || 0;
    if (msg.stop_reason !== "pause_turn") break;
    console.log(`[${label}] pause_turn – folytatás (${i + 1}.)`);
  }
  if (msg?.stop_reason === "max_tokens") console.warn(`[${label}] A válasz elérte a max_tokens korlátot (${maxTokens}) – lehet, hogy csonka.`);

  const cost = (usage.input * PRICE_PER_MTOK.input + usage.output * PRICE_PER_MTOK.output +
    usage.cacheWrite * PRICE_PER_MTOK.cacheWrite + usage.cacheRead * PRICE_PER_MTOK.cacheRead) / 1e6;
  console.log(`[AI költség] ${label}: ${usage.input} bemeneti + ${usage.output} kimeneti token, ` +
    `gyorsítótár: ${usage.cacheWrite} írás / ${usage.cacheRead} olvasás, ` +
    `${usage.searches} keresés (${filterCount} találatszűrés), ${secs()} mp · token-költség ≈ $${cost.toFixed(3)} (a keresések díja ezen felül)`);

  // A kész válasz az utolsó eszközhasználat utáni szöveg; az előtte lévő szövegblokkok
  // a keresés közbeni megjegyzések. Ha nincs ilyen, az összes szöveget visszaadjuk.
  let lastTool = -1;
  content.forEach((b, i) => { if (b.type !== "text") lastTool = i; });
  const pick = blocks => blocks.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  const text = pick(content.slice(lastTool + 1)) || pick(content);
  return { text, stopReason: msg?.stop_reason || null, usage };
}

module.exports = { callClaudeWithSearch };
