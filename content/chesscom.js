// Slow Down Chess - chess.com adapter (live, daily and bot games).
(() => {
  'use strict';
  const API = window.SlowDownChess;
  if (!API) return;

  const FILES = 'abcdefgh';
  const q = (sel, r = document) => r.querySelector(sel);
  const GAME_PATH = /^\/(game\/(live|daily|computer)|play\/(online|computer|coach)|live|daily)(\/|$)/;

  function board() {
    if (!GAME_PATH.test(location.pathname)) return null;
    return q('wc-chess-board, chess-board');
  }
  const flipped = b => b.classList.contains('flipped');

  function moveList() { return q('wc-simple-move-list, vertical-move-list, wc-move-list'); }
  function nodes(l) { return [...l.querySelectorAll('.node')].filter(n => n.textContent.trim()); }

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
    // The player at the bottom of the board is the user; the board is flipped when playing black.
    getUserColor() { const b = board(); return b ? (flipped(b) ? 'b' : 'w') : null; },

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
      const b = board();
      if (!b) return null;
      const bottom = flipped(b) ? 'b' : 'w';
      if (q('.clock-bottom.clock-player-turn')) return bottom;
      if (q('.clock-top.clock-player-turn')) return bottom === 'w' ? 'b' : 'w';
      return null;
    },

    isGameOver: () => !!q('[class*="game-over-modal"], .player-game-over-component, .game-over-header-component'),
  });
})();
