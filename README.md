# 90perc.hu

AI-alapú futballtipp szolgáltatás: napi tippek admin jóváhagyással, Telegram- és e-mail-kiküldés,
Stripe-előfizetés, automatikus eredményelszámolás és publikus statisztika.

## Indítás

```bash
npm install
npm start          # alapértelmezetten a 3000-es porton
```

Node 18+ kell. Az adatok (felhasználók, tipp-előzmények) JSON fájlokban vannak a `DATA_DIR`
könyvtárban (Renderen a `/data` perzisztens lemez).

## Felépítés

| Fájl | Tartalom |
|---|---|
| `server.js` | Tipp-motor: odds lekérés, AI tippgenerálás, kombik, eredményjelölés, ütemező, tipp végpontok |
| `routes/auth.js` | Regisztráció, belépés, e-mail megerősítés, jelszó-visszaállítás |
| `routes/adminUsers.js` | Admin: felhasználók listázása, csomag állítása, deaktiválás |
| `routes/stripe.js` | Stripe webhook, checkout, ügyfélportál, admin szinkron |
| `routes/telegram.js` | Telegram bot (`/tippek`, admin `/elemzes`) |
| `routes/analyzer.js` | Meccselemző előzmények szinkronja |
| `routes/odds.js` | Odds API proxy |
| `lib/security.js` | XSS-szűrés az API válaszokon, próbálkozás-korlátozás |
| `lib/admin.js` | Admin jogosultság ellenőrzése |
| `auth.js`, `users.js`, `mailer.js` | Session, felhasználó-tár, e-mail küldés |
| `public/` | Frontend (statikus HTML oldalak) |

## Környezeti változók

**Kötelező éles üzemben**

| Változó | Leírás |
|---|---|
| `SESSION_SECRET` | Session cookie aláíró kulcs (nélküle minden újraindítás kiléptet mindenkit) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Az admin fiók induláskor ezekből jön létre – ez az egyetlen admin belépési mód a felületen. Az `ADMIN_PASSWORD` X-Admin-Password headerben a `/api/match-list` külső (mondomatutit) hívásához is jó |
| `BASE_URL` | Az oldal címe (alapértelmezés: `https://90perc.hu`) |
| `ANTHROPIC_API_KEY` | AI tippgenerálás |
| `ODDS_API_KEY` | The Odds API kulcs |

**Telegram**

| Változó | Leírás |
|---|---|
| `TG_BOT_TOKEN` | Bot token |
| `TG_WEBHOOK_SECRET` | Webhook titok (A-Z, a-z, 0-9, `_`, `-`). Induláskor automatikusan regisztrálja a webhookot; nélküle a bot nem fogad parancsot |
| `TG_CHAT_ID` | Publikus csatorna, ahová a tippek mennek |
| `TG_PRIVATE_CHAT_ID` | Admin privát chat értesítésekhez |
| `ADMIN_TELEGRAM_CHAT_ID` | Az admin Telegram chat ID-ja – csak ő használhatja az `/elemzes` parancsot |

**Fizetés és e-mail**

| Változó | Leírás |
|---|---|
| `PAID_MODE` | `true` = csak aktív előfizető látja a tippeket |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` | Stripe előfizetés |
| `RESEND_API_KEY` vagy `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | E-mail küldés (egyik sem → csak a logba ír) |
| `MAIL_FROM` | Feladó cím |

**Opcionális**

| Változó | Leírás |
|---|---|
| `FOOTBALLDATA_TOKEN` | football-data.org – 90 perces eredményekhez, a tabellaadatokhoz és a Poisson value szűrőhöz |
| `ODDS_PROXY_TOKEN` | Az odds proxy külső (nem belépett) hívásaihoz |
| `MONDOMATUTIT_ADMIN_PASSWORD` | A „→ Mondomatutit” gombhoz: ezzel küldi át a tippet a mondomatutit.hu-ra |
| `MONDOMATUTIT_URL` | A mondomatutit címe (alapértelmezés: `https://mondomatutit.hu`) |
| `DATA_DIR` | Adatkönyvtár (alapértelmezés: `/data`) |
