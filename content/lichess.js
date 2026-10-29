// Slow Down Chess - lichess.org adapter (round / game pages only).
(() => {
  'use strict';
  const API = window.SlowDownChess;
  if (!API) return;

  const FILES = 'abcdefgh';
  const ROLE = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' };
  const q = (sel, r = document) => r.querySelector(sel);

  const wrap = () => q('.round__app .cg-wrap') || (q('.round__app cg-board') || {}).closest?.('.cg-wrap') || null;
  const orientation = w => (w.classList.contains('orientation-black') ? 'b' : 'w');
  const me = () => (document.body.dataset.user || '').toLowerCase();

  function nameOf(sel) {
    const a = q(`${sel} a[href^="/@/"]`);
    if (!a) return null;
    return a.getAttribute('href').slice(3).split(/[/?#]/)[0].toLowerCase();
  }

  // Returns the user's color, or null when the page is a game between two other players.
  function userColor() {
    const w = wrap();
    if (!w) return null;
    const bottom = orientation(w);
    const u = me();
    if (!u) return bottom;
    const bn = nameOf('.ruser-bottom'), tn = nameOf('.ruser-top');
    if (bn === u) return bottom;
    if (tn === u) return bottom === 'w' ? 'b' : 'w';
    if (bn && tn) return null; // spectating
    return bottom;
  }
  const userIsBottom = () => { const w = wrap(); return !!w && userColor() === orientation(w); };

  // Lichess rotates the (obfuscated) tag names of its move list, so find it structurally:
  // the parent of the highlighted current move, or one of the known containers before any move.
  let listEl = null;
  function moveList() {
    if (listEl && !listEl.isConnected) listEl = null;
    if (!listEl) {
      const active = q('.round__app .a1t');
      if (active && !active.closest('.round__app__board')) listEl = active.parentElement;
      else listEl = q('.round__app l4x, .round__app i5d > app, .round__app .moves');
    }
    return listEl;
  }
  // Moves are the children whose text is not a bare move number.
  const moveEls = l => [...l.children].filter(c => !/^\d+$/.test(c.textContent.trim()));

  API.registerAdapter({
    name: 'lichess',
    settingKey: 'enabledLichess',
    findBoard: wrap,
    getGameKey: () => location.pathname.split('/')[1] || '/',
    getUserColor: userColor,

    getPly() {
      const l = moveList();
      return l ? moveEls(l).length : null;
    },

    isViewingHistory() {
      const l = moveList();
      if (!l) return false;
      const all = moveEls(l);
      const active = l.querySelector('.a1t');
      return !!(active && all.length && active !== all[all.length - 1]);
    },

    // Notation of the move at ply p (1-based), e.g. "Nxe5" or "Qh5+".
    getMoveSan(p) {
      const l = moveList();
      const el = l && moveEls(l)[p - 1];
      return el ? el.textContent.trim() : null;
    },

    // Board position as "sq:cr,..." built from chessground's piece transforms.
    getSnapshot() {
      const w = wrap();
      const board = w && w.querySelector('cg-board');
      if (!board) return null;
      const size = board.getBoundingClientRect().width / 8;
      if (!size) return null;
      const black = orientation(w) === 'b';
      const out = [];
      for (const p of board.querySelectorAll('piece')) {
        if (p.classList.contains('ghost') || p.classList.contains('fading')) continue;
        if (p.classList.contains('dragging')) return null; // mid-drag: skip this poll
        const m = /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(p.style.transform);
        if (!m) continue;
        const x = +m[1] / size, y = +m[2] / size;
        const fx = Math.round(x), fy = Math.round(y);
        if (Math.abs(x - fx) > 0.2 || Math.abs(y - fy) > 0.2) return null; // mid-animation
        const file = black ? 7 - fx : fx, rank = black ? fy : 7 - fy;
        if (file < 0 || file > 7 || rank < 0 || rank > 7) continue;
        const color = p.classList.contains('white') ? 'w' : 'b';
        let role = 'x';
        for (const c of p.classList) if (ROLE[c]) { role = ROLE[c]; break; }
        out.push(`${FILES[file]}${rank + 1}:${color}${role}`);
      }
      out.sort();
      return out.join(',');
    },

    getTimeControl() {
      const el = q('.game__meta .setup') || q('.game__meta .header');
      const tc = API.parseTimeControl(el && el.textContent);
      if (tc) return tc;
      // Fallback: the <title> contains e.g. "10+5 Rapid"
      return API.parseTimeControl(document.title);
    },

    getUserClockSeconds() {
      const t = q(`.round__app ${userIsBottom() ? '.rclock-bottom' : '.rclock-top'} .time`);
      return t ? API.parseClock(t.textContent) : null;
    },
    getOpponentClockSeconds() {
      const t = q(`.round__app ${userIsBottom() ? '.rclock-top' : '.rclock-bottom'} .time`);
      return t ? API.parseClock(t.textContent) : null;
    },
    // The running clock carries .running and .rclock-white / .rclock-black.
    getTurnColor() {
      const c = q('.round__app .rclock.running');
      return c ? (c.classList.contains('rclock-black') ? 'b' : 'w') : null;
    },

    isGameOver: () => !!q('.round__app .result-wrap, .round__app .follow-up, .round__app .rcontrols .follow-up'),
  });
})();
