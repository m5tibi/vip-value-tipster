// ── E-mail küldés ─────────────────────────────────────────
// Szolgáltató-független SMTP (Brevo, Resend, Postmark, Mailgun… mind ad SMTP hozzáférést).
// Ha nincs beállítva SMTP, a rendszer NEM omlik össze: csak logolja, hogy mit küldene.
// Így az app e-mail szolgáltató nélkül is működik (a linket a logból ki tudod másolni).

const nodemailer = require("nodemailer");

const HOST = process.env.SMTP_HOST;
const PORT = Number(process.env.SMTP_PORT || 587);
const USER = process.env.SMTP_USER;
const PASS = process.env.SMTP_PASS;
const FROM = process.env.MAIL_FROM || "AI Foci Tippek <noreply@example.com>";

const configured = !!(HOST && USER && PASS);

let transporter = null;
if (configured) {
  transporter = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: PORT === 465,          // 465 = implicit TLS, 587 = STARTTLS
    auth: { user: USER, pass: PASS },
  });
  transporter.verify()
    .then(() => console.log(`✓ E-mail küldés bekötve (${HOST}:${PORT})`))
    .catch(e => console.warn(`⚠️  SMTP ellenőrzés sikertelen: ${e.message}`));
} else {
  console.log("ℹ️  SMTP nincs beállítva – a rendszer-e-mailek csak a logba íródnak (SMTP_HOST/USER/PASS).");
}

async function send({ to, subject, html, text }) {
  if (!configured) {
    console.log(`\n📧 [E-MAIL SZIMULÁCIÓ] Címzett: ${to}\n   Tárgy: ${subject}\n   ${(text || "").split("\n").join("\n   ")}\n`);
    return { ok: true, simulated: true };
  }
  try {
    await transporter.sendMail({ from: FROM, to, subject, html, text });
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
    <div style="color:#00e676;font-weight:700;font-size:19px;margin-bottom:14px">⚽ AI Foci Tippek</div>
    <div style="font-weight:700;font-size:16px;margin-bottom:10px;color:#e0e0e0">${title}</div>
    ${body}
    <div style="margin-top:24px;padding-top:14px;border-top:1px solid #1e3a2f;color:#546e7a;font-size:11px;line-height:1.6">
      18+ · A szerencsejáték függőséget okozhat. Segítség: 116-123<br>
      Ezt az e-mailt azért kaptad, mert fiókot hoztál létre az AI Foci Tippek oldalon.
    </div>
  </div>
</div>`;

const button = (url, label) =>
  `<a href="${url}" style="display:inline-block;background:#00e676;color:#07111d;font-weight:700;padding:12px 22px;border-radius:8px;text-decoration:none;margin:14px 0">${label}</a>`;

async function sendVerification(to, url) {
  return send({
    to,
    subject: "Erősítsd meg az e-mail címed – AI Foci Tippek",
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
    subject: "Jelszó visszaállítása – AI Foci Tippek",
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

module.exports = { send, sendVerification, sendPasswordReset, configured };
