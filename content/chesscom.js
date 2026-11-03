// Slow Down Chess - chess.com adapter (live, daily and bot games).
(() => {
  'use strict';
  const API = window.SlowDownChess;
  if (!API) return;

  const FILES = 'abcdefgh';
  const q = (sel, r = document) => r.querySelector(sel);
  // Live games now land on a bare /game/<id>; the older /game/live|daily|computer/<id> shapes still exist.
  const GAME_PATH = /^\/(game\/(live|daily|computer|\d+)|play\/(online|computer|coach)|live|daily)(\/|$)/;

  function board() {
    if (!GAME_PATH.test(location.pathname)) return null;
    return q('wc-chess-board, chess-board');
  }
  const flipped = b => b.classList.contains('flipped') || b.hasAttribute('flipped') || !!b.closest('.flipped');
  const other = c => (c === 'w' ? 'b' : 'w');

  function moveList() { return q('wc-simple-move-list, vertical-move-list, wc-move-list'); }
  function nodes(l) { return [...l.querySelectorAll('.node')].filter(n => n.textContent.trim()); }

  // Which color sits at the bottom of the board (the user, during play). chess.com has changed its
  // markup more than once, so several signals are tried, strongest first, and a confident answer is
  // kept for the rest of the game so a signal that disappears mid-game cannot flip it.
  let colorMemo = { key: null, color: null };
  function bottomColor() {
    const b = board();
    if (!b) return null;
    if (colorMemo.key !== location.pathname) colorMemo = { key: location.pathname, color: null };
    let c = null;
    // 1. The board is flipped when the user plays black.
    if (flipped(b)) c = 'b';
    // 2. The clock / player components carry the color.
    if (!c) {
      const colorOf = el => !el ? null
        : el.matches('.clock-black, .player-black, [data-color="black"]') || el.querySelector('.clock-black, .player-black, [data-color="black"]') ? 'b'
        : el.matches('.clock-white, .player-white, [data-color="white"]') || el.querySelector('.clock-white, .player-white, [data-color="white"]') ? 'w' : null;
      c = colorOf(q('.clock-bottom')) || colorOf(q('.player-bottom'));
      if (!c) { const t = colorOf(q('.clock-top')) || colorOf(q('.player-top')); if (t) c = other(t); }
    }
    // 3. The first rank label drawn on the board is "8" with white at the bottom, "1" with black.
    if (!c) {
      const t = b.querySelector('.coordinates text, svg text');
      const v = t && t.textContent.trim();
      if (v === '1') c = 'b'; else if (v === '8') c = 'w';
    }
    // 4. Whichever clock is running belongs to the side to move.
    if (!c) {
      const l = moveList();
      if (l) {
        const stm = nodes(l).length % 2 === 0 ? 'w' : 'b';
        if (q('.clock-bottom.clock-player-turn')) c = stm; else if (q('.clock-top.clock-player-turn')) c = other(stm);
      }
    }
    if (c) colorMemo.color = c;
    return colorMemo.color || 'w';
  }

  function clockText(sel) {
    const c = q(sel);
    if (!c) return null;
    const t = c.querySelector('.clock-time-monospace, [class*="clock-time"]') || c;
    return t.textContent;
  }

  API.registerAdapter({
    name: 'chess.com',
    settingKey: 'enabledChesscom',
    findBoard: board,
    getGameKey: () => location.pathname,
    getUserName: () => {
      const e = q('.player-bottom [data-test-element="user-tagline-username"], .player-bottom .cc-user-username-component');
      const t = e ? e.textContent.trim() : '';
      return t && !/^(Player|Opponent)$/i.test(t) ? t : null;
    },
    // The player at the bottom of the board is the user.
    getUserColor: bottomColor,

    getPly() {
      const l = moveList();
      return l ? nodes(l).length : null;
    },

    // The current move is marked with .selected on the node's inner span.
    isViewingHistory() {
      const l = moveList();
      if (!l) return false;
      const all = nodes(l);
      const sel = l.querySelector('.selected');
      const node = sel && sel.closest('.node');
      return !!(node && all.length && node !== all[all.length - 1]);
    },

    // Who played the move at ply p (1-based), from the node's own markup rather than its position in
    // the list, so a stray node can not shift every move to the other side. Null when unknown.
    getMoveColor(p) {
      const l = moveList();
      const el = l && nodes(l)[p - 1];
      if (!el) return null;
      if (el.matches('.white-move, .white, [data-color="white"]')) return 'w';
      if (el.matches('.black-move, .black, [data-color="black"]')) return 'b';
      // A full row holds the move number, then white's move, then black's.
      const row = el.parentElement;
      const sib = row ? [...row.querySelectorAll('.node')].filter(n => n.textContent.trim()) : [];
      if (sib.length === 2) return sib[0] === el ? 'w' : 'b';
      return null;
    },

    // Notation of the move at ply p (1-based), e.g. "Nxe5" or "Qh5+".
    getMoveSan(p) {
      const l = moveList();
      const el = l && nodes(l)[p - 1];
      return el ? el.textContent.trim() : null;
    },

    // Board position as "sq:cr,..." from the piece classes (e.g. "piece wp square-52").
    getSnapshot() {
      const b = board();
      if (!b) return null;
      const out = [];
      for (const p of b.querySelectorAll('.piece')) {
        let sq = null, kind = null;
        for (const c of p.classList) {
          let m;
          if ((m = /^square-([1-8])([1-8])$/.exec(c))) sq = `${FILES[+m[1] - 1]}${m[2]}`;
          else if (/^[wb][pnbrqk]$/.test(c)) kind = c;
        }
        if (sq && kind) out.push(`${sq}:${kind}`);
      }
      if (!out.length) return null;
      out.sort();
      return out.join(',');
    },

    getTimeControl() {
      // Try the explicit time-control labels chess.com renders in the game header / sidebar.
      const sels = [
        '[data-cy="time-control"]', '.time-control-component', '.game-time-control', '.board-layout-sidebar [class*="time-control"]',
        '.player-top [class*="time-control"]', '[class*="game-info"] [class*="time"]', '.board-layout-top [class*="time-control"]',
      ];
      for (const s of sels) {
        const el = q(s);
        const tc = el && API.parseTimeControl(el.textContent);
        if (tc) return tc;
      }
      // Live/new-game URLs sometimes carry the time control as "?time=600+5".
      const m = /[?&](?:time|tc)=(\d+)(?:\+(\d+))?/.exec(location.search);
      if (m) return { base: +m[1], inc: m[2] ? +m[2] : 0, label: `${Math.round(+m[1] / 60)}|${m[2] || 0}` };
      // Otherwise the base time is whatever both clocks show before the first move; the core
      // infers the increment from clock jumps and marks the label with "?" until it is sure.
      const l = moveList();
      if (l && nodes(l).length === 0) {
        const a = API.parseClock(clockText('.clock-bottom')), b = API.parseClock(clockText('.clock-top'));
        if (a && b && a === b && a >= 15) return { base: a, inc: 0, label: `${Math.round(a / 60)} min`, guessed: true, incUnknown: true };
      }
      return null;
    },

    getUserClockSeconds: () => API.parseClock(clockText('.clock-bottom')),
    getOpponentClockSeconds: () => API.parseClock(clockText('.clock-top')),

    // chess.com marks the running clock with .clock-player-turn.
    getTurnColor() {
      const bottom = bottomColor();
      if (!bottom) return null;
      if (q('.clock-bottom.clock-player-turn')) return bottom;
      if (q('.clock-top.clock-player-turn')) return other(bottom);
      return null;
    },

    isGameOver: () => !!q('[class*="game-over-modal"], .player-game-over-component, .game-over-header-component'),
  });
})();
