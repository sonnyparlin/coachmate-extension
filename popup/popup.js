const DEFAULTS = {
  startMove: 5, budgetMode: 'auto', expectedMoves: 40, fixedSeconds: 15,
  lowClockSeconds: 20, forcedFloorSeconds: 5, forcedFloorPercent: 25, sound: true, block: false, showOverlay: true, enabledLichess: true, enabledChesscom: true,
};
const $ = id => document.getElementById(id);
const form = $('settings');
const fmt = n => (n == null ? '–' : `${Math.round(n * 10) / 10}s`);

function applyVisibility() {
  for (const el of form.querySelectorAll('[data-show]')) {
    const [k, v] = el.dataset.show.split('=');
    el.classList.toggle('hidden', form.elements[k].value !== v);
  }
}

chrome.storage.sync.get(DEFAULTS, s => {
  for (const [k, v] of Object.entries(s)) {
    const el = form.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
  applyVisibility();
});

form.addEventListener('input', e => {
  const el = e.target;
  if (!el.name) return;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.type === 'number') { v = parseFloat(v); if (!Number.isFinite(v)) return; }
  chrome.storage.sync.set({ [el.name]: v });
  applyVisibility();
});

// ---- live stats from the active tab ----
let tabId = null;
function send(type, cb) {
  if (tabId == null) return cb(null);
  chrome.tabs.sendMessage(tabId, { type }, res => { void chrome.runtime.lastError; cb(res || null); });
}
function renderStats(s) {
  const active = !!(s && s.active);
  $('inactive').classList.toggle('hidden', active);
  $('site').textContent = s && s.site ? s.site : '–';
  $('tc').textContent = active ? (s.tc || 'not found') : '–';
  $('budget').textContent = active ? `${fmt(s.budget)}${s.budgetSource === 'auto' ? '' : s.budgetSource === 'fixed' ? ' (fixed)' : ' (default)'}` : '–';
  $('next').textContent = active ? `#${s.nextMove} · ${fmt(s.nextAllowance)}` : '–';
  $('judged').textContent = s ? s.judged : 0;
  $('tooSoon').textContent = s ? s.tooSoon : 0;
  $('avg').textContent = s ? fmt(s.avg) : '–';
  $('pause').classList.toggle('on', !!(s && s.paused));
  $('pause').textContent = s && s.paused ? 'Resume' : 'Pause';
  $('pause').disabled = !s;
}
function renderGames(games) {
  games = (games || []).slice(0, 8);
  $('history').classList.toggle('hidden', games.length === 0);
  const when = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
  $('games').innerHTML = games.map(g =>
    `<tr><td class="dim">${when(g.date)}</td><td class="dim">${g.site}${g.tc ? ' ' + g.tc : ''}</td>` +
    `<td class="r"><b class="${g.tooSoon ? 'bad' : ''}">${g.tooSoon}</b>/${g.judged} quick</td><td class="r dim">avg ${fmt(g.avg)}</td></tr>`
  ).join('');
}
function renderLifetime(lt) {
  lt = lt || { judged: 0, tooSoon: 0 };
  $('ltJudged').textContent = lt.judged;
  $('ltTooSoon').textContent = lt.tooSoon;
  $('ltPct').textContent = lt.judged ? `${Math.round(100 * (1 - lt.tooSoon / lt.judged))}%` : '–';
}
function refresh() { send('getStats', s => { renderStats(s); if (s && s.lifetime) renderLifetime(s.lifetime); }); }

chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  tabId = tabs[0] ? tabs[0].id : null;
  refresh();
  setInterval(refresh, 1000);
});
chrome.storage.local.get({ lifetime: null, games: [] }, l => { renderLifetime(l.lifetime); renderGames(l.games); });
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.games) renderGames(c.games.newValue); });
$('clearGames').addEventListener('click', () => chrome.storage.local.set({ games: [] }, () => renderGames([])));

$('pause').addEventListener('click', () => send('togglePause', renderStats));
$('resetGame').addEventListener('click', () => send('resetGameStats', renderStats));
$('resetLifetime').addEventListener('click', () => {
  chrome.storage.local.set({ lifetime: { judged: 0, tooSoon: 0 } }, () => renderLifetime(null));
});
