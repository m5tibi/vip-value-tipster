/* Akciós sáv (Black November) – a /api/promo alapján jelenik meg, visszaszámlálóval.
 * Beillesztés: <script src="/promo.js" defer></script>. Ha nincs aktív akció, nem csinál semmit.
 * Az előfizetés oldalon (elofizetes.html) az árat is átírja: áthúzott alapár + akciós ár. */
(function () {
  const lang = () => (window.getLang ? window.getLang() : 'hu');
  const fmt  = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const TXT = {
    hu: {
      bar:   (p) => `🖤 <b>BLACK NOVEMBER</b> – az első ${p.months} hónap <b>−${p.percentOff}%</b>: <b>${fmt(p.promoPrice)} Ft/hó</b>`,
      cta:   'Előfizetek →',
      left:  'Még',
      d: 'nap', h: 'óra', m: 'perc',
      sub:   (p) => `Az első ${p.months} hónapban ${fmt(p.promoPrice)} Ft/hó, utána ${fmt(p.basePrice)} Ft/hó – bármikor lemondható.`,
      badge: (p) => `🖤 BLACK NOVEMBER · −${p.percentOff}%`,
      ends:  'Az akció vége:',
    },
    en: {
      bar:   (p) => `🖤 <b>BLACK NOVEMBER</b> – first ${p.months} months <b>−${p.percentOff}%</b>: <b>${fmt(p.promoPrice)} HUF/mo</b>`,
      cta:   'Subscribe →',
      left:  '',
      d: 'd', h: 'h', m: 'min',
      sub:   (p) => `${fmt(p.promoPrice)} HUF/mo for the first ${p.months} months, then ${fmt(p.basePrice)} HUF/mo – cancel anytime.`,
      badge: (p) => `🖤 BLACK NOVEMBER · −${p.percentOff}%`,
      ends:  'Offer ends:',
    },
  };
  const T = () => TXT[lang()] || TXT.hu;

  function remaining(endsAt) {
    const ms = new Date(endsAt).getTime() - Date.now();
    if (ms <= 0) return null;
    const d = Math.floor(ms / 86400000), h = Math.floor(ms / 3600000) % 24, m = Math.floor(ms / 60000) % 60;
    const t = T();
    return `${t.left ? t.left + ' ' : ''}${d ? d + ' ' + t.d + ' ' : ''}${h} ${t.h} ${m} ${t.m}`;
  }

  function injectStyles() {
    const css = `
      #promo-bar{position:relative;z-index:50;background:linear-gradient(90deg,#000,#1b1b1b 50%,#000);
        border-bottom:1px solid #00e676;color:#f2f2f2;font:500 13px/1.4 Inter,system-ui,sans-serif;
        padding:9px 16px;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;justify-content:center;text-align:center}
      #promo-bar b{color:#00e676}
      #promo-bar .pb-time{color:#9fb3c8;font-variant-numeric:tabular-nums}
      #promo-bar a{background:#00e676;color:#060e1b;font-weight:700;text-decoration:none;
        padding:5px 12px;border-radius:6px;white-space:nowrap}
      .promo-old{font-size:20px;color:#5d7a96;text-decoration:line-through;margin-right:4px}
      .promo-badge{display:inline-block;background:#000;color:#00e676;border:1px solid #00e676;
        font-size:11px;font-weight:700;letter-spacing:1.5px;padding:4px 10px;border-radius:999px;margin-bottom:14px}
      .promo-ends{font-size:12px;color:#9fb3c8;margin:-18px 0 22px;text-align:center}
      #promo-bar.pb-bottom{position:fixed;left:0;right:0;bottom:0;border-bottom:none;border-top:1px solid #00e676;box-shadow:0 -6px 20px rgba(0,0,0,.5)}`;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  }

  function renderBar(p) {
    if (document.getElementById('promo-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'promo-bar';
    const onPricing = /elofizetes\.html$/.test(location.pathname);
    bar.innerHTML = `<span>${T().bar(p)}</span><span class="pb-time"></span>` +
      (onPricing ? '' : `<a href="/elofizetes.html">${T().cta}</a>`);
    // Ha az oldal navigációja fix/ragadós, a sáv a képernyő aljára kerül (különben a nav eltakarná)
    const nav = document.querySelector('nav');
    const navPos = nav ? getComputedStyle(nav).position : '';
    if (navPos === 'fixed' || navPos === 'sticky') {
      bar.classList.add('pb-bottom');
      document.body.appendChild(bar);
      document.body.style.paddingBottom = (bar.offsetHeight + 4) + 'px';
    } else {
      document.body.insertBefore(bar, document.body.firstChild);
    }
    const tick = () => {
      const r = remaining(p.endsAt);
      if (!r) { bar.remove(); return; }
      bar.querySelector('.pb-time').textContent = '⏳ ' + r;
    };
    tick(); setInterval(tick, 30000);
  }

  function renderPricing(p) {
    const amount = document.querySelector('.plan-price .amount');
    if (!amount || amount.dataset.promo) return;
    amount.dataset.promo = '1';
    const old = document.createElement('span');
    old.className = 'promo-old'; old.textContent = fmt(p.basePrice);
    amount.parentNode.insertBefore(old, amount);
    amount.textContent = fmt(p.promoPrice);
    const sub = document.querySelector('.plan-sub');
    if (sub) { sub.removeAttribute('data-i18n'); sub.textContent = T().sub(p); }
    const card = document.querySelector('.plan-card');
    if (card) {
      const badge = document.createElement('div');
      badge.className = 'promo-badge'; badge.textContent = T().badge(p);
      card.insertBefore(badge, card.firstChild);
    }
    const subLine = document.querySelector('.pricing-wrap .sub');
    if (subLine) {
      const ends = document.createElement('p');
      ends.className = 'promo-ends';
      ends.textContent = `${T().ends} ${new Date(p.endsAt).toLocaleString(lang() === 'en' ? 'en-GB' : 'hu-HU',
        { timeZone: 'Europe/Budapest', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
      subLine.after(ends);
    }
  }

  async function init() {
    let p;
    try { const r = await fetch('/api/promo'); if (!r.ok) return; p = await r.json(); } catch (e) { return; }
    if (!p || !p.active || !remaining(p.endsAt)) return;
    injectStyles();
    renderBar(p);
    renderPricing(p);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
