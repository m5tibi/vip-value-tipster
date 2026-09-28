// ── Közös statisztika-szabály (tippek.html track record sáv, statisztika.html) ──
// UGYANEZ a szabály és kerekítés fut a szerveren is (server.js: isStatTip / statProfit,
// /api/public-stats), így minden kijelzés ugyanazt a számot mutatja.

var STAT_SETTLED = ['won', 'lost', 'push', 'half_won', 'half_lost'];

// Publikált (jóváhagyott), lezárt foci single, free és kombi tippek számítanak
function statTip(t) {
  if (t.type === 'value' || t.approved === false) return false;
  if (STAT_SETTLED.indexOf(t.result) === -1) return false;
  return t.type === 'combo' || t.type === 'free' || /soccer|foci|⚽/i.test((t.sport || '') + ' ' + (t.sportLabel || ''));
}

// Tippenkénti profit egységben, 2 tizedesre kerekítve
function statProfit(t) {
  if (t.type === 'combo') {
    if (['won', 'lost', 'push'].indexOf(t.result) === -1) return 0;
    var payout = (typeof t.comboPayout === 'number' && t.comboPayout > 0)
      ? t.comboPayout
      : (t.result === 'won' ? (parseFloat(t.odds) || 0) : t.result === 'push' ? 1 : 0);
    return +(payout - 1).toFixed(2);
  }
  var o = parseFloat(t.odds) || 1;
  if (t.result === 'won')       return +(o - 1).toFixed(2);
  if (t.result === 'lost')      return -1;
  if (t.result === 'half_won')  return +((o - 1) / 2).toFixed(2);
  if (t.result === 'half_lost') return -0.5;
  return 0;
}

// Nyerési arány (push és fél-eredmény súlyozva), profit, ROI
function statCalc(tips) {
  var settled = tips.filter(function (t) { return STAT_SETTLED.indexOf(t.result) !== -1; });
  var cnt = function (r) { return settled.filter(function (t) { return t.result === r; }).length; };
  var won = cnt('won'), lost = cnt('lost'), halfWon = cnt('half_won'), halfLost = cnt('half_lost');
  var decN = won + lost + halfWon + halfLost;
  var winRate = decN ? (((won + halfWon * 0.5) / decN) * 100).toFixed(1) : null;
  var profit = settled.reduce(function (sum, t) { return sum + statProfit(t); }, 0);
  var roi = settled.length ? ((profit / settled.length) * 100).toFixed(1) : null;
  return { settled: settled.length, winRate: winRate, profit: parseFloat(profit.toFixed(2)), roi: roi };
}

// Melyik hónaphoz tartozik egy dátum ("2026. 7. 30. …", "2026-07-30…", "09. 17. 21:00")
function statYearMonth(dateStr) {
  if (!dateStr) return null;
  var s = String(dateStr);
  var iso = s.match(/^(\d{4})-(\d{2})/);
  if (iso) return iso[1] + '-' + iso[2];
  var hu = s.match(/^(\d{4})\.\s*(\d{1,2})\./);
  if (hu) return hu[1] + '-' + ('0' + hu[2]).slice(-2);
  var cm = s.match(/^(\d{2})\.\s*(\d{2})/);
  if (cm) return new Date().getFullYear() + '-' + ('0' + (+cm[1])).slice(-2);
  var d = new Date(s);
  if (!isNaN(d.getTime())) return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
  return null;
}
// Egy tipp hónapja: a hozzáadás napja, ennek hiányában a meccs kezdése
function statTipMonth(t) { return statYearMonth(t.addedAt || t.commence); }
