// Meta (Facebook) Pixel süti-hozzájárulással. A szerver a /tracking.js válaszban ez elé
// teszi a window.__META_PIXEL_ID és window.__META_PURCHASE_VALUE értékét.
// - A pixel CSAK a látogató hozzájárulása után töltődik be (GDPR / Eht.: marketingsüti).
// - Döntés előtt az események (pl. CompleteRegistration) sorba állnak, és elfogadáskor mennek ki.
// - window.track(esemény, paraméterek, opciók) – biztonságosan hívható pixel nélkül is.
// - window.openCookieSettings() – a hozzájárulás módosítása (adatvédelmi oldal gombja).
(function () {
  var PID = window.__META_PIXEL_ID || "";
  var KEY = "cookie_consent_v1";
  var queue = [], loaded = false;

  function getConsent() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function setConsent(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }

  function loadPixel() {
    if (loaded || !PID) return;
    loaded = true;
    /* eslint-disable */
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
    n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
    document,'script','https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    window.fbq("init", PID);
    window.fbq("track", "PageView");
    queue.forEach(function (a) { window.fbq.apply(null, a); });
    queue = [];
  }

  window.track = function (event, params, opts) {
    if (!PID) return;
    var args = ["track", event, params || {}, opts || {}];
    if (loaded) window.fbq.apply(null, args);
    else if (getConsent() !== "denied") queue.push(args);
  };
  window.META_PURCHASE_VALUE = Number(window.__META_PURCHASE_VALUE) || 0;

  function clearFbCookies() {
    ["_fbp", "_fbc"].forEach(function (c) {
      var host = location.hostname.replace(/^www\./, "");
      document.cookie = c + "=; Max-Age=0; path=/";
      document.cookie = c + "=; Max-Age=0; path=/; domain=." + host;
    });
  }

  function isEn() { try { return window.getLang && window.getLang() === "en"; } catch (e) { return false; } }

  function showBanner() {
    if (!PID || document.getElementById("cookie-banner")) return;
    var en = isEn();
    var bar = document.createElement("div");
    bar.id = "cookie-banner";
    bar.setAttribute("role", "dialog");
    bar.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;max-width:760px;margin:0 auto;" +
      "background:#0c1a2e;border:1px solid #1a2f4a;border-radius:12px;padding:14px 16px;color:#dce8f5;" +
      "font:13px/1.5 Inter,system-ui,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.5);display:flex;flex-wrap:wrap;gap:10px;align-items:center";
    var txt = document.createElement("div");
    txt.style.cssText = "flex:1 1 320px";
    txt.innerHTML = en
      ? "🍪 We use a marketing cookie (Meta Pixel) to measure our Facebook ads – only with your consent. <a href=\"/adatvedelem.html#sutik\" style=\"color:#00e676\">Details</a>"
      : "🍪 Marketing sütit (Meta Pixel) használunk a Facebook-hirdetéseink mérésére – csak a hozzájárulásoddal. <a href=\"/adatvedelem.html#sutik\" style=\"color:#00e676\">Részletek</a>";
    var btns = document.createElement("div");
    btns.style.cssText = "display:flex;gap:8px;flex:0 0 auto";
    function mk(label, primary, onClick) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.cssText = "cursor:pointer;border-radius:8px;padding:8px 14px;font:600 13px Inter,system-ui,sans-serif;" +
        (primary ? "background:#00e676;color:#060e1b;border:0" : "background:transparent;color:#dce8f5;border:1px solid #1a2f4a");
      b.onclick = onClick;
      return b;
    }
    btns.appendChild(mk(en ? "Necessary only" : "Csak a szükséges", false, function () {
      var wasGranted = getConsent() === "granted";
      setConsent("denied"); queue = []; clearFbCookies(); bar.remove();
      if (wasGranted || loaded) location.reload();     // a már betöltött pixelt csak újratöltés állítja le
    }));
    btns.appendChild(mk(en ? "Accept" : "Elfogadom", true, function () {
      setConsent("granted"); bar.remove(); loadPixel();
    }));
    bar.appendChild(txt);
    bar.appendChild(btns);
    document.body.appendChild(bar);
  }

  window.openCookieSettings = function () {
    var b = document.getElementById("cookie-banner");
    if (b) b.remove();
    showBanner();
  };

  function init() {
    if (!PID) return;
    var c = getConsent();
    if (c === "granted") loadPixel();
    else if (c !== "denied") showBanner();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
