// ── E-mail küldés ─────────────────────────────────────────
// Három mód, ebben a sorrendben:
//  1) RESEND_API_KEY → Resend HTTP API (AJÁNLOTT: a PaaS-ok néha blokkolják az SMTP portokat,
//     a HTTPS-t soha; kevesebb beállítás, megbízhatóbb).
//  2) SMTP_HOST/USER/PASS → bármely SMTP szolgáltató (Resend, Brevo, Postmark…).
//  3) Semmi → a rendszer NEM omlik össze: a levelet csak a logba írja (a linket onnan kimásolhatod).

const nodemailer = require("nodemailer");

const RESEND_KEY = process.env.RESEND_API_KEY;
const HOST = process.env.SMTP_HOST;
const PORT = Number(process.env.SMTP_PORT || 587);
const USER = process.env.SMTP_USER;
const PASS = process.env.SMTP_PASS;
const FROM = process.env.MAIL_FROM || "90perc.hu <noreply@90perc.hu>";

const useResendApi = !!RESEND_KEY;
const useSmtp      = !useResendApi && !!(HOST && USER && PASS);
const configured   = useResendApi || useSmtp;

let transporter = null;
if (useResendApi) {
  console.log("✓ E-mail küldés bekötve (Resend HTTP API)");
} else if (useSmtp) {
  transporter = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: PORT === 465,          // 465 = implicit TLS, 587 = STARTTLS
    auth: { user: USER, pass: PASS },
  });
  transporter.verify()
    .then(() => console.log(`✓ E-mail küldés bekötve (SMTP ${HOST}:${PORT})`))
    .catch(e => console.warn(`⚠️  SMTP ellenőrzés sikertelen: ${e.message}`));
} else {
  console.log("ℹ️  E-mail küldés nincs beállítva – a levelek csak a logba íródnak (állítsd be a RESEND_API_KEY-t).");
}

async function send({ to, subject, html, text }) {
  if (!configured) {
    console.log(`\n📧 [E-MAIL SZIMULÁCIÓ] Címzett: ${to}\n   Tárgy: ${subject}\n   ${(text || "").split("\n").join("\n   ")}\n`);
    return { ok: true, simulated: true };
  }
  try {
    if (useResendApi) {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to: [to], subject, html, text }),
      });
      if (!r.ok) {
        const body = await r.text();
        console.error(`📧 Resend hiba (${to}): HTTP ${r.status} – ${body.slice(0, 200)}`);
        return { ok: false, error: `HTTP ${r.status}` };
      }
    } else {
      await transporter.sendMail({ from: FROM, to, subject, html, text });
    }
    console.log(`📧 E-mail elküldve: ${to} – ${subject}`);
    return { ok: true };
  } catch (e) {
    console.error(`📧 E-mail hiba (${to}):`, e.message);
    return { ok: false, error: e.message };
  }
}

// ── Sablonok ──
const shell = (title, body) => `
<div style="background:#07111d;padding:24px;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#0d1b2a;border:1px solid #1e3a2f;border-radius:12px;padding:24px;color:#cfd8dc">
    <div style="color:#00e676;font-weight:700;font-size:19px;margin-bottom:14px">⚽ 90perc.hu</div>
    <div style="font-weight:700;font-size:16px;margin-bottom:10px;color:#e0e0e0">${title}</div>
    ${body}
    <div style="margin-top:24px;padding-top:14px;border-top:1px solid #1e3a2f;color:#546e7a;font-size:11px;line-height:1.6">
      18+ · A szerencsejáték függőséget okozhat. Segítség: 116-123<br>
      Ezt az e-mailt azért kaptad, mert fiókot hoztál létre a 90perc.hu oldalon.
    </div>
  </div>
</div>`;

const button = (url, label) =>
  `<a href="${url}" style="display:inline-block;background:#00e676;color:#07111d;font-weight:700;padding:12px 22px;border-radius:8px;text-decoration:none;margin:14px 0">${label}</a>`;

async function sendVerification(to, url) {
  return send({
    to,
    subject: "Erősítsd meg az e-mail címed – 90perc.hu",
    text: `Üdv!\n\nErősítsd meg az e-mail címed az alábbi linkre kattintva:\n${url}\n\nA link 24 óráig érvényes.\nHa nem te regisztráltál, hagyd figyelmen kívül ezt a levelet.`,
    html: shell("Erősítsd meg az e-mail címed", `
      <p style="line-height:1.7;margin:0 0 6px">Köszönjük a regisztrációt! Kattints az alábbi gombra az e-mail címed megerősítéséhez.</p>
      ${button(url, "✅ E-mail cím megerősítése")}
      <p style="color:#78909c;font-size:12px;line-height:1.6;margin:6px 0 0">
        A link <b>24 óráig</b> érvényes. Ha a gomb nem működik, másold be ezt a címet a böngésződbe:<br>
        <span style="color:#80cbc4;word-break:break-all">${url}</span><br><br>
        Ha nem te regisztráltál, egyszerűen hagyd figyelmen kívül ezt a levelet.
      </p>`),
  });
}

async function sendPasswordReset(to, url) {
  return send({
    to,
    subject: "Jelszó visszaállítása – 90perc.hu",
    text: `Jelszó visszaállítása\n\nKattints ide az új jelszó beállításához:\n${url}\n\nA link 1 óráig érvényes.\nHa nem te kérted, hagyd figyelmen kívül ezt a levelet – a jelszavad változatlan marad.`,
    html: shell("Jelszó visszaállítása", `
      <p style="line-height:1.7;margin:0 0 6px">Kérted a jelszavad visszaállítását. Kattints az alábbi gombra új jelszó beállításához.</p>
      ${button(url, "🔑 Új jelszó beállítása")}
      <p style="color:#78909c;font-size:12px;line-height:1.6;margin:6px 0 0">
        A link <b>1 óráig</b> érvényes. Ha a gomb nem működik, másold be ezt a címet a böngésződbe:<br>
        <span style="color:#80cbc4;word-break:break-all">${url}</span><br><br>
        Ha nem te kérted, hagyd figyelmen kívül ezt a levelet – a jelszavad változatlan marad.
      </p>`),
  });
}


// ── Előfizetés aktiválva ──────────────────────────────────────
async function sendPlanActivated(to, paidUntil) {
  const lejarat = paidUntil
    ? new Date(paidUntil).toLocaleDateString("hu-HU", { year:"numeric", month:"long", day:"numeric" })
    : null;
  return send({
    to,
    subject: "✅ Pro előfizetésed aktív – 90perc.hu",
    text: `Üdv!\n\nPro előfizetésed aktív.${lejarat ? " Érvényes: " + lejarat + "." : ""}\n\nHozzáférsz a napi AI tippekhez és az elemzőhöz:\nhttps://90perc.hu/tippek.html`,
    html: shell("Pro előfizetésed aktív! 🎉", `
      <p style="line-height:1.7;margin:0 0 10px">Köszönjük az előfizetést! Mostantól hozzáférsz az összes napi AI tipphez és a meccs elemzőhöz.</p>
      ${lejarat ? `<p style="color:#78909c;font-size:13px;margin:0 0 14px">Előfizetés érvényes: <b style="color:#00e676">${lejarat}</b></p>` : ""}
      ${button("https://90perc.hu/tippek.html", "⚽ Megnézem a tippeket")}
      <p style="color:#78909c;font-size:12px;margin:14px 0 0">Az előfizetést bármikor kezelheted vagy mondhatod le az <a href="https://90perc.hu/elofizetes.html" style="color:#80cbc4">Előfizetés kezelése oldalon</a>.</p>
    `),
  });
}

// ── Előfizetés lemondva/lejárt ────────────────────────────────
async function sendPlanCancelled(to) {
  return send({
    to,
    subject: "Előfizetésed lejárt – 90perc.hu",
    text: `Előfizetésed lejárt vagy lemondásra került.\n\nA track record és az összesített statisztika továbbra is elérhető számodra.\nHa szeretnél újra előfizetni: https://90perc.hu/elofizetes.html`,
    html: shell("Előfizetésed lejárt", `
      <p style="line-height:1.7;margin:0 0 10px">Előfizetésed lejárt vagy lemondásra került. Sajnáljuk, hogy elmész!</p>
      <p style="line-height:1.7;margin:0 0 14px;color:#78909c">A track record és a nyilvános statisztika továbbra is elérhető számodra az <a href="https://90perc.hu/statisztika.html" style="color:#80cbc4">Előzmény oldalon</a>.</p>
      ${button("https://90perc.hu/elofizetes.html", "🔄 Újra előfizetek")}
    `),
  });
}

// ── Új tippek értesítő ────────────────────────────────────────
async function sendNewTips(to, tips, combos, frees = []) {
  if (!tips.length && !combos.length && !frees.length) return;

  const freeRows = frees.map(t => {
    const note = (t.note || t.ai_note || "").trim();
    return `<tr>
      <td colspan="4" style="padding:8px 6px 2px;border-bottom:none;background:rgba(139,92,246,.08)">
        <span style="color:#c084fc;font-weight:700;font-size:12px">🆓 INGYENES TIPP</span>
        <span style="color:#e0e0e0;font-weight:600;margin-left:8px">${t.match}</span>
        <span style="color:#80cbc4;font-size:12px;margin-left:8px">${t.market || ''}</span>
        <span style="color:#e0e0e0;margin-left:8px">${t.pick}</span>
        <span style="color:#f59e0b;font-weight:700;margin-left:8px">@ ${t.odds}</span>
        ${t.commence ? `<span style="color:#546e7a;font-size:11px;margin-left:8px">🕐 ${t.commence}</span>` : ''}
      </td>
    </tr>
    ${note ? `<tr><td colspan="4" style="padding:2px 6px 8px;border-bottom:1px solid #2d1f4e;color:#c084fc;font-size:12px;line-height:1.5;background:rgba(139,92,246,.05)">${note}</td></tr>` : '<tr><td colspan="4" style="border-bottom:1px solid #2d1f4e;background:rgba(139,92,246,.05)"></td></tr>'}`;
  }).join("");

  const tipRows = tips.map(t => {
    const note = (t.note || t.ai_note || "").trim();
    return `<tr>
      <td colspan="4" style="padding:8px 6px 2px;border-bottom:none">
        <span style="color:#e0e0e0;font-weight:600">${t.match}</span>
        <span style="color:#80cbc4;font-size:12px;margin-left:8px">${t.market}</span>
        <span style="color:#e0e0e0;margin-left:8px">${t.pick}</span>
        <span style="color:#f59e0b;font-weight:700;margin-left:8px">@ ${t.odds}</span>
        ${t.commence ? `<span style="color:#546e7a;font-size:11px;margin-left:8px">🕐 ${t.commence}</span>` : ''}
      </td>
    </tr>
    ${note ? `<tr><td colspan="4" style="padding:2px 6px 8px;border-bottom:1px solid #1e3a2f;color:#A0A0C0;font-size:12px;line-height:1.5">${note}</td></tr>` : '<tr><td colspan="4" style="border-bottom:1px solid #1e3a2f"></td></tr>'}`;
  }).join("");

  const comboRows = combos.map(c =>
    `<tr>
      <td colspan="4" style="padding:8px 6px;border-bottom:1px solid #1e3a2f;color:#ffcc80">
        🎰 Kombi: ${c.legs.map(l => l.pick).join(" + ")} @ <b>${c.odds}</b>
      </td>
    </tr>`
  ).join("");

  // Tárgy és cím dinamikusan
  const parts = [];
  if (tips.length)   parts.push(`${tips.length} új VIP tipp`);
  if (combos.length) parts.push(`${combos.length} kombi`);
  if (frees.length)  parts.push(`🆓 ingyenes tipp`);
  const subject = `⚽ ${parts.join(" + ")} – 90perc.hu`;
  const title   = parts.join(" + ");

  return send({
    to,
    subject,
    text: [...tips, ...frees].map(t => `${t.match}: ${t.pick} @ ${t.odds}`).join("\n"),
    html: shell(title, `
      <table style="width:100%;border-collapse:collapse;margin:10px 0">
        <thead>
          <tr style="color:#546e7a;font-size:11px;text-transform:uppercase">
            <th style="padding:6px;text-align:left;border-bottom:1px solid #1e3a2f">Meccs</th>
            <th style="padding:6px;text-align:left;border-bottom:1px solid #1e3a2f">Piac</th>
            <th style="padding:6px;text-align:left;border-bottom:1px solid #1e3a2f">Tipp</th>
            <th style="padding:6px;text-align:left;border-bottom:1px solid #1e3a2f">Odds</th>
          </tr>
        </thead>
        <tbody>${freeRows}${tipRows}${comboRows}</tbody>
      </table>
      ${button("https://90perc.hu/tippek.html", "⚽ Megnézem az összes tippet")}
      <p style="color:#546e7a;font-size:11px;margin:10px 0 0">A tippek kizárólag tájékoztató jellegűek. A fogadás pénzügyi veszteséggel járhat.</p>
    `),
  });
}

// ── Heti összefoglaló ─────────────────────────────────────────
async function sendWeeklySummary(to, stats) {
  const { won, lost, push, halfWon, halfLost, profit, roi, winRate, settled } = stats;
  const profitStr = (profit >= 0 ? "+" : "") + profit.toFixed(2);
  const profitColor = profit >= 0 ? "#00e676" : "#ef4444";
  return send({
    to,
    subject: `📊 Heti összefoglaló – 90perc.hu`,
    text: `Heti eredmények:\nLezárt tippek: ${settled}\nNyert: ${won} | Vesztett: ${lost}\nProfit: ${profitStr} egység | ROI: ${roi}%`,
    html: shell("Heti összefoglaló", `
      <p style="color:#78909c;margin:0 0 14px">Az elmúlt 7 nap tippjeinek összesítése:</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0">
        <div style="background:#07111d;border-radius:8px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:#fff">${settled}</div>
          <div style="font-size:11px;color:#546e7a;margin-top:4px">Lezárt tipp</div>
        </div>
        <div style="background:#07111d;border-radius:8px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:#00e676">${winRate}%</div>
          <div style="font-size:11px;color:#546e7a;margin-top:4px">Nyerési arány</div>
        </div>
        <div style="background:#07111d;border-radius:8px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:${profitColor}">${profitStr}</div>
          <div style="font-size:11px;color:#546e7a;margin-top:4px">Egységnyi profit</div>
        </div>
        <div style="background:#07111d;border-radius:8px;padding:14px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:${profitColor}">${(roi >= 0 ? "+" : "") + roi}%</div>
          <div style="font-size:11px;color:#546e7a;margin-top:4px">ROI</div>
        </div>
      </div>
      <p style="color:#546e7a;font-size:12px;margin:8px 0">${won} nyert · ${lost} vesztett · ${(halfWon||0)+(halfLost||0)} fél · ${push||0} visszajár</p>
      ${button("https://90perc.hu/statisztika.html", "📊 Teljes track record")}
    `),
  });
}


// ── Előfizetés lemondva (de még aktív az időszak végéig) ─────
async function sendSubscriptionCancelled(to, activeUntil) {
  const dateStr = activeUntil
    ? new Date(activeUntil).toLocaleDateString("hu-HU", { year:"numeric", month:"long", day:"numeric" })
    : null;
  return send({
    to,
    subject: "Az előfizetésed lemondásra került – 90perc.hu",
    text: `Lemondtad a 90perc.hu előfizetésedet.${dateStr ? ` A hozzáférésed ${dateStr}-ig aktív marad.` : ""} Köszönjük, hogy velünk voltál!`,
    html: shell("Előfizetés lemondva", `
      <p style="line-height:1.7;margin:0 0 10px">Lemondtad a 90perc.hu előfizetésedet.</p>
      ${dateStr
        ? `<p style="line-height:1.7;margin:0 0 14px">Hozzáférésed még aktív marad <b style="color:#00e676">${dateStr}</b>-ig – addig továbbra is eléred az összes tippet és az elemzőt.</p>`
        : `<p style="line-height:1.7;margin:0 0 14px;color:#78909c">Hozzáférésed hamarosan megszűnik.</p>`
      }
      ${button("https://90perc.hu/elofizetes.html", "🔄 Újra előfizetek")}
      <p style="color:#78909c;font-size:12px;margin:14px 0 0">Köszönjük, hogy velünk voltál! A track record és a statisztika ezután is szabadon megtekinthető a <a href="https://90perc.hu/statisztika.html" style="color:#80cbc4">Statisztika oldalon</a>.</p>
    `),
  });
}

// ── Előfizetés lejárt (időszak vége, hozzáférés megszűnt) ────
async function sendSubscriptionExpired(to) {
  return send({
    to,
    subject: "Előfizetésed lejárt – 90perc.hu",
    text: `A 90perc.hu előfizetésed lejárt, hozzáférésed megszűnt. Ha folytatni szeretnéd, iratkozz fel újra: https://90perc.hu/elofizetes.html`,
    html: shell("Előfizetésed lejárt", `
      <p style="line-height:1.7;margin:0 0 10px">A 90perc.hu előfizetésed lejárt, és a hozzáférésed megszűnt.</p>
      <p style="line-height:1.7;margin:0 0 14px;color:#78909c">Ha újra szeretnél hozzáférni a napi tippekhez és az elemzőhöz, egyszerűen iratkozz fel újra az alábbi gombbal.</p>
      ${button("https://90perc.hu/elofizetes.html", "🔄 Újra előfizetek – 14 990 Ft/hó")}
      <p style="color:#78909c;font-size:12px;margin:14px 0 0">A track record és a statisztika ezután is szabadon megtekinthető a <a href="https://90perc.hu/statisztika.html" style="color:#80cbc4">Statisztika oldalon</a>.</p>
    `),
  });
}

module.exports = { send, sendVerification, sendPasswordReset, sendPlanActivated, sendPlanCancelled, sendSubscriptionCancelled, sendSubscriptionExpired, sendNewTips, sendWeeklySummary, configured };
