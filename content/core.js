// Slow Down Chess - core content script.
// Shared by the lichess and chess.com adapters, which call SlowDownChess.registerAdapter().
(() => {
  'use strict';
  if (window.__slowDownChessLoaded) return;
  window.__slowDownChessLoaded = true;

  const DEFAULTS = {
    startMove: 5,             // the countdown applies from this move of yours on (the first 4 are free)
    budgetMode: 'auto',       // 'auto' (from time control) | 'fixed'
    expectedMoves: 40,        // game length used to split the base time
    fixedSeconds: 15,         // used in fixed mode, or when no time control can be read
    lowClockSeconds: 20,      // countdown switches off when your clock is below this
    forcedFloorPercent: 25,   // after the opponent captures or checks, your reply only needs this share of the budget...
    forcedFloorSeconds: 5,    // ...capped at this many seconds (and never under 1 s)
    sound: true,
    block: false,             // cover the board until the countdown ends
    showOverlay: true,
    enabledLichess: true,
    enabledChesscom: true,
  };

  const hasStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync;
  let settings = { ...DEFAULTS };
  let lifetime = { judged: 0, tooSoon: 0 };
  let adapter = null;

  // ---------- helpers exposed to adapters ----------
  const FRACTIONS = { '½': 0.5, '¼': 0.25, '¾': 0.75 };

  // Returns { base: seconds, inc: seconds, label } or null.
  function parseTimeControl(text) {
    if (!text) return null;
    const t = String(text).replace(/ /g, ' ');
    let m;
    // lichess "10+5", "½+0", "1.5+0"
    if ((m = /(\d+(?:[.,]\d+)?|[½¼¾])\s*\+\s*(\d+)/.exec(t))) {
      const base = FRACTIONS[m[1]] != null ? FRACTIONS[m[1]] : parseFloat(m[1].replace(',', '.'));
      return { base: base * 60, inc: +m[2], label: `${m[1]}+${m[2]}` };
    }
    // chess.com "3 | 2", "10|5"
    if ((m = /(\d+)\s*\|\s*(\d+)/.exec(t))) return { base: +m[1] * 60, inc: +m[2], label: `${m[1]}|${m[2]}` };
    if (/\bday/i.test(t)) return null; // correspondence
    if ((m = /(\d+)\s*min/i.exec(t))) return { base: +m[1] * 60, inc: 0, label: `${m[1]} min` };
    if ((m = /(\d+)\s*sec/i.exec(t))) return { base: +m[1], inc: 0, label: `${m[1]} sec` };
    return null;
  }

  // "9:59", "0:09.5", "1:00:00" -> seconds, or null.
  function parseClock(text) {
    if (!text) return null;
    const t = String(text).replace(/[^\d:.]/g, '');
    const m = /^(?:(\d+):)?(\d+):(\d{1,2})(?:\.(\d))?$/.exec(t);
    if (!m) return null;
    const h = m[1] ? +m[1] : 0;
    return h * 3600 + +m[2] * 60 + +m[3] + (m[4] ? +m[4] / 10 : 0);
  }

  // ---------- state ----------
  function freshState() {
    return {
      gameKey: null, active: false, userColor: null, initialized: false,
      snapshot: null, pending: null,
      turn: null, ply: null, plyMode: false, plyMissingSince: 0, evUserMoves: 0,
      tc: null, budget: null, budgetSource: 'fallback',
      counterStart: null, deadline: null, allowance: null, forcing: null, readyNotified: false,
      judged: 0, tooSoon: 0, thinkTimes: [], moveLog: [], summary: null, startedAt: Date.now(),
      paused: false, gameOver: false, lowClock: false, clock: null,
      oppClock: null, oppClockMin: null, oppClockBefore: null, incWatchUntil: 0, incWatchMax: null, incSamples: [],
      flashUntil: 0, flashMsg: '',
    };
  }
  const S = freshState();
  function resetGame(key) {
    const paused = S.paused;
    Object.assign(S, freshState(), { gameKey: key, paused });
  }
  // Moves the user has played after ply p (white moves on odd plies).
  const userMovesAtPly = p => (S.userColor === 'w' ? Math.ceil(p / 2) : Math.floor(p / 2));
  const userMoves = () => (S.plyMode && S.ply != null ? userMovesAtPly(S.ply) : S.evUserMoves);
  const opposite = c => (c === 'w' ? 'b' : 'w');

  // ---------- budget ----------
  function computeBudget() {
    if (settings.budgetMode === 'fixed' || !S.tc) {
      return { seconds: Math.max(0.5, +settings.fixedSeconds || 0), source: S.tc ? 'fixed' : 'fallback' };
    }
    const n = Math.max(1, +settings.expectedMoves || 40);
    let s = S.tc.base / n + S.tc.inc;
    s = Math.max(1, Math.round(s * 2) / 2);
    return { seconds: s, source: 'auto' };
  }
  const startMove = () => Math.max(1, Math.round(+settings.startMove) || 1);
  // Seconds you must wait before your move number `moveNo` (0 while the countdown is not yet active).
  // `forcing` is set when the opponent just captured or gave check: the reply is usually obvious,
  // so only a short floor applies, enough to look for a trap or an in-between move.
  function allowanceFor(moveNo, forcing) {
    if (moveNo < startMove()) return 0;
    const budget = S.budget != null ? S.budget : computeBudget().seconds;
    if (!forcing) return budget;
    // Scales with the time control: a share of the budget, capped in seconds, never under 1 s.
    let floor = budget * ((+settings.forcedFloorPercent || 0) / 100);
    floor = Math.min(floor, +settings.forcedFloorSeconds || Infinity);
    floor = Math.max(1, Math.round(floor * 2) / 2);
    return Math.min(budget, floor);
  }
  // What kind of reply the opponent's move (in algebraic notation) demands.
  function classifyMove(san) {
    if (!san) return null;
    if (san.includes('+')) return 'check';
    if (san.includes('x')) return 'capture';
    return null;
  }

  // ---------- move detection ----------
  // Snapshot strings look like "a1:wr,b1:wn,...". Returns a list of mover colors
  // in the order they moved, or 'reset' when the board changed too much (new game).
  function diffMovers(oldSnap, newSnap) {
    const parse = s => { const m = new Map(); for (const e of s.split(',')) { if (!e) continue; const [sq, p] = e.split(':'); m.set(sq, p); } return m; };
    const a = parse(oldSnap), b = parse(newSnap);
    const colors = new Set();
    let placed = 0;
    for (const [sq, p] of b) if (a.get(sq) !== p) { placed++; colors.add(p[0]); }
    if (placed > 4) return 'reset';
    if (colors.size === 0) return [];
    if (colors.size === 1) return [...colors];
    // Both colors moved inside one poll interval (e.g. a premove fired). Side to move went first.
    const first = S.turn || opposite(S.userColor);
    return [first, opposite(first)];
  }

  function startCounter(now, moveNo, forcing) {
    S.forcing = forcing || null;
    S.allowance = allowanceFor(moveNo, S.forcing);
    S.counterStart = now;
    S.deadline = now + S.allowance * 1000;
    S.readyNotified = false;
  }
  function stopCounter() { S.counterStart = null; S.deadline = null; S.allowance = null; S.forcing = null; }

  function judge(now, moveNo) {
    const elapsed = (now - S.counterStart) / 1000;
    const tooSoon = now < S.deadline - 50;
    S.thinkTimes.push(elapsed);
    S.moveLog.push({ moveNo, elapsed, allowance: S.allowance, tooSoon, forcing: S.forcing });
    S.judged++;
    lifetime.judged++;
    if (tooSoon) {
      S.tooSoon++;
      lifetime.tooSoon++;
      flash(`Too quick! ${elapsed.toFixed(1)}s of ${fmt(S.allowance)}s`);
      if (settings.sound) buzz();
    }
    saveLifetime();
  }

  // Build the end-of-game summary once and remember it until the next game starts.
  function finishGame() {
    const log = S.moveLog;
    const n = log.length;
    const quick = log.filter(m => m.tooSoon);
    let streak = 0, best = 0;
    for (const m of log) { streak = m.tooSoon ? 0 : streak + 1; if (streak > best) best = streak; }
    const times = log.map(m => m.elapsed);
    const sum = times.reduce((a, b) => a + b, 0);
    const forcingLog = log.filter(m => m.forcing), quietLog = log.filter(m => !m.forcing);
    S.summary = {
      forcingJudged: forcingLog.length, forcingQuick: forcingLog.filter(m => m.tooSoon).length,
      quietJudged: quietLog.length, quietQuick: quietLog.filter(m => m.tooSoon).length,
      site: adapter.name, date: Date.now(), tc: S.tc ? S.tc.label : null, budget: S.budget,
      judged: n, tooSoon: quick.length, onTime: n - quick.length,
      pct: n ? Math.round(100 * (n - quick.length) / n) : null,
      avg: n ? sum / n : null, fastest: n ? Math.min(...times) : null, slowest: n ? Math.max(...times) : null,
      bestStreak: best, quickMoves: quick.map(m => m.moveNo),
      avgShortfall: quick.length ? quick.reduce((a, m) => a + (m.allowance - m.elapsed), 0) / quick.length : null,
    };
    if (hasStorage && n) {
      chrome.storage.local.get({ games: [] }, l => {
        const games = [S.summary, ...(l.games || [])].slice(0, 50);
        chrome.storage.local.set({ games });
      });
    }
  }

  // `played` is how many moves the user has made once this move is on the board;
  // `san` is the move's notation when the move list provides it.
  function handleMove(mover, now, played, san) {
    S.turn = opposite(mover);
    if (mover === S.userColor) {
      if (S.counterStart != null && !S.paused && !S.lowClock && !S.gameOver) judge(now, played);
      stopCounter();
      S.oppClockMin = null; // opponent's turn starts: track their lowest clock reading
    } else {
      // The countdown only ever starts when the opponent moves, and only from `startMove` on.
      if (played + 1 >= startMove()) startCounter(now, played + 1, classifyMove(san));
      if (S.tc && S.tc.incUnknown && S.oppClock != null) {
        // Their clock only falls during their turn, so the lowest reading is the pre-increment value
        // even if the site applied the increment a tick before the board updated.
        S.oppClockBefore = S.oppClockMin != null ? Math.min(S.oppClockMin, S.oppClock) : S.oppClock;
        S.incWatchMax = S.oppClock; S.incWatchUntil = now + 1500;
      }
    }
  }

  // chess.com shows no time-control label during a game, so when only the base time is known
  // we infer the increment from how much the opponent's clock jumps right after they move.
  const COMMON_INC = [0, 1, 2, 3, 5, 10, 15, 20, 30, 45, 60];
  function watchIncrement(now) {
    if (!S.tc || !S.tc.incUnknown) return;
    if (S.incWatchUntil && now <= S.incWatchUntil) {
      if (S.oppClock != null && S.oppClock > S.incWatchMax) S.incWatchMax = S.oppClock;
      return;
    }
    if (S.incWatchUntil) {
      S.incWatchUntil = 0;
      const delta = S.incWatchMax - S.oppClockBefore;
      if (delta >= -0.5) S.incSamples.push(Math.max(0, Math.round(delta)));
      if (S.incSamples.length >= 2) {
        const sorted = [...S.incSamples].sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];
        const inc = COMMON_INC.reduce((best, c) => (Math.abs(c - med) < Math.abs(best - med) ? c : best), 0);
        S.tc = { ...S.tc, inc, label: `${Math.round(S.tc.base / 60)}|${inc}`, guessed: S.incSamples.length < 4 };
      }
    }
  }

  function setActive(on) {
    if (!on && S.active) { S.active = false; stopCounter(); }
  }

  function tick() {
    const now = Date.now();
    try {
      if (!adapter || !settings[adapter.settingKey]) { setActive(false); render(now); return; }
      const board = adapter.findBoard();
      if (!board) { setActive(false); render(now); return; }
      const key = adapter.getGameKey();
      if (key !== S.gameKey) resetGame(key);
      const color = adapter.getUserColor();
      if (!color) { setActive(false); render(now); return; }
      S.userColor = color;
      S.active = true;

      if (!S.tc && adapter.getTimeControl) { const tc = adapter.getTimeControl(); if (tc) S.tc = tc; }
      const b = computeBudget();
      S.budget = b.seconds; S.budgetSource = b.source;

      // Move detection. Primary signal: the move list's ply count, which only grows when a move is
      // played (stepping back and forward through the game never changes it). Fallback when no
      // move list is on the page: diffing the board position, guarded by the history check.
      const ply = adapter.getPly ? adapter.getPly() : null;
      if (ply != null) {
        S.plyMissingSince = 0;
        if (!S.plyMode || S.ply == null) {
          S.plyMode = true; S.ply = ply;
          if (S.turn == null) S.turn = ply % 2 === 0 ? 'w' : 'b';
        } else if (ply < S.ply - 2) {
          resetGame(key); S.userColor = color; S.active = true; S.plyMode = true; S.ply = ply;
        } else if (ply < S.ply) {
          S.ply = ply; stopCounter(); // takeback
        } else if (ply > S.ply) {
          for (let p = S.ply + 1; p <= ply; p++) {
            S.ply = p;
            handleMove(p % 2 === 1 ? 'w' : 'b', now, userMovesAtPly(p), adapter.getMoveSan ? adapter.getMoveSan(p) : null);
          }
        }
        S.initialized = true;
        if (!S.tc && ply === 0 && adapter.getUserClockSeconds) {
          const c = adapter.getUserClockSeconds();
          if (c && c >= 15) S.tc = { base: c, inc: 0, label: `${Math.round(c / 60)} min`, guessed: true, incUnknown: true };
        }
      } else if (S.plyMode) {
        // The move list vanished (zen mode?). Give it 2 s, then fall back to board diffing.
        if (!S.plyMissingSince) S.plyMissingSince = now;
        else if (now - S.plyMissingSince > 2000) { S.plyMode = false; S.evUserMoves = userMovesAtPly(S.ply); S.snapshot = null; S.pending = null; }
      }

      if (!S.plyMode) {
        const viewingHistory = adapter.isViewingHistory ? adapter.isViewingHistory() : false;
        const snap = viewingHistory ? null : adapter.getSnapshot();
        if (snap) {
          if (snap === S.pending && snap !== S.snapshot) {
            if (S.snapshot != null) {
              const movers = diffMovers(S.snapshot, snap);
              // Without notation, a shrinking piece count is the only capture hint we have.
              const san = snap.split(',').length < S.snapshot.split(',').length ? 'x' : null;
              if (movers === 'reset') { resetGame(key); S.userColor = color; S.active = true; }
              else movers.forEach(m => { if (m === color) S.evUserMoves++; handleMove(m, now, S.evUserMoves, san); });
            }
            S.snapshot = snap;
            S.initialized = true;
          }
          S.pending = snap;
        }
      }

      S.gameOver = !!(adapter.isGameOver && adapter.isGameOver());
      if (S.gameOver && !S.summary && S.initialized) { stopCounter(); finishGame(); }
      S.clock = adapter.getUserClockSeconds ? adapter.getUserClockSeconds() : null;
      S.oppClock = adapter.getOpponentClockSeconds ? adapter.getOpponentClockSeconds() : null;
      if (S.oppClock != null && S.turn != null && S.turn !== color && !S.incWatchUntil) {
        S.oppClockMin = S.oppClockMin == null ? S.oppClock : Math.min(S.oppClockMin, S.oppClock);
      }
      S.lowClock = S.clock != null && S.clock < +settings.lowClockSeconds;
      if (S.turn == null && adapter.getTurnColor) S.turn = adapter.getTurnColor();
      watchIncrement(now);

      if (S.counterStart != null && !S.readyNotified && now >= S.deadline && S.turn === color && !S.paused && !S.gameOver) {
        S.readyNotified = true;
        if (settings.sound && !S.lowClock) chime();
      }
    } catch (e) {
      // Never let a DOM hiccup kill the loop.
      console.debug('[SlowDownChess]', e);
    }
    render(now);
  }

  // ---------- sound ----------
  let audio = null;
  function tone(freq, dur, type = 'sine', gain = 0.08, when = 0) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, audio.currentTime + when);
      g.gain.exponentialRampToValueAtTime(gain, audio.currentTime + when + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + when + dur);
      o.connect(g).connect(audio.destination);
      o.start(audio.currentTime + when); o.stop(audio.currentTime + when + dur + 0.05);
    } catch (_) { /* audio unavailable */ }
  }
  const chime = () => { tone(660, 0.12); tone(990, 0.18, 'sine', 0.08, 0.12); };
  const buzz = () => { tone(180, 0.18, 'square', 0.05); tone(150, 0.25, 'square', 0.05, 0.2); };

  // ---------- overlay ----------
  const fmt = n => (n == null ? '–' : (Math.round(n * 10) / 10).toString());
  let host, root, els = {}, blocker, collapsed = false, pos = null;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel { position: fixed; top: 84px; right: 16px; width: 212px; z-index: 2147483000;
      font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #e8ecf1; background: rgba(22, 25, 31, 0.93); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,0.35); user-select: none; backdrop-filter: blur(6px);
      transition: border-color .15s, box-shadow .15s; }
    .panel.hidden { display: none; }
    .panel.flash { border-color: #ff4d4d; box-shadow: 0 0 0 3px rgba(255,77,77,.35), 0 8px 28px rgba(0,0,0,.35); animation: shake .35s; }
    @keyframes shake { 0%,100% { transform: translateX(0) } 25% { transform: translateX(-4px) } 75% { transform: translateX(4px) } }
    .bar { display: flex; align-items: center; gap: 6px; padding: 7px 8px 7px 11px; cursor: grab; border-bottom: 1px solid rgba(255,255,255,0.07); }
    .bar:active { cursor: grabbing; }
    .title { font-weight: 600; font-size: 12px; letter-spacing: .02em; opacity: .9; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mini { display: none; font-weight: 700; font-variant-numeric: tabular-nums; }
    .btn { all: unset; cursor: pointer; width: 22px; height: 22px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center;
      font-size: 12px; color: #c9d1db; }
    .btn:hover { background: rgba(255,255,255,0.1); }
    .btn.on { color: #ffd166; }
    .body { padding: 10px 12px 10px; text-align: center; }
    .label { font-size: 12px; color: #b8c0cc; min-height: 16px; }
    .ring { position: relative; width: 112px; height: 112px; margin: 6px auto 4px; }
    .ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
    .track { fill: none; stroke: rgba(255,255,255,0.1); stroke-width: 7; }
    .prog { fill: none; stroke: #ff5a5a; stroke-width: 7; stroke-linecap: round; transition: stroke .2s; }
    .num { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
    .num small { font-size: 14px; font-weight: 600; margin-left: 1px; opacity: .7; }
    .wait .num { color: #ff6b6b; } .wait .prog { stroke: #ff5a5a; }
    .ok .num { color: #5be38a; } .ok .prog { stroke: #45d37a; }
    .idle .num { color: #9aa4b2; } .idle .prog { stroke: transparent; }
    .meta { font-size: 11px; color: #8f98a5; margin-top: 2px; min-height: 14px; }
    .stats { display: flex; justify-content: space-between; gap: 6px; margin-top: 9px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.07);
      font-size: 11px; color: #aeb6c2; }
    .stats b { color: #e8ecf1; font-weight: 600; }
    .stats .bad b { color: #ff6b6b; }
    .summary { text-align: left; }
    .sum-head { font-size: 12px; color: #b8c0cc; text-align: center; }
    .sum-big { font-size: 26px; font-weight: 700; text-align: center; margin-top: 4px; letter-spacing: -.02em; }
    .sum-big.bad { color: #ff6b6b; } .sum-big.good { color: #5be38a; }
    .sum-sub { font-size: 11px; color: #8f98a5; text-align: center; margin-bottom: 8px; }
    .sum-rows div { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: #aeb6c2; padding: 2px 0; }
    .sum-rows b { color: #e8ecf1; font-weight: 600; white-space: nowrap; }
    .sum-list { font-size: 11px; color: #ffb3b3; margin-top: 6px; text-align: center; }
    .panel.collapsed .body { display: none; }
    .panel.collapsed { width: auto; min-width: 150px; }
    .panel.collapsed .mini { display: inline; }
    .panel.collapsed .bar { border-bottom: 0; }
  `;

  function buildOverlay() {
    host = document.createElement('div');
    host.id = 'slow-down-chess-host';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="panel idle" part="panel">
        <div class="bar">
          <span class="title">⏱ Slow Down</span>
          <span class="mini">—</span>
          <button class="btn pause" title="Pause / resume">⏸</button>
          <button class="btn collapse" title="Collapse / expand">–</button>
        </div>
        <div class="body">
          <div class="live">
            <div class="label">Waiting for a game…</div>
            <div class="ring">
              <svg viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="44"/><circle class="prog" cx="50" cy="50" r="44"/></svg>
              <div class="num">—</div>
            </div>
            <div class="meta"></div>
          </div>
          <div class="summary" style="display:none"></div>
          <div class="stats">
            <span>Moves <b class="m">0</b></span>
            <span class="bad">Too quick <b class="ts">0</b></span>
            <span>Avg <b class="avg">–</b></span>
          </div>
        </div>
      </div>`;
    els = {
      panel: root.querySelector('.panel'), bar: root.querySelector('.bar'), mini: root.querySelector('.mini'),
      label: root.querySelector('.label'), num: root.querySelector('.num'), prog: root.querySelector('.prog'),
      meta: root.querySelector('.meta'), m: root.querySelector('.m'), ts: root.querySelector('.ts'), avg: root.querySelector('.avg'),
      pause: root.querySelector('.pause'), collapse: root.querySelector('.collapse'),
      live: root.querySelector('.live'), summary: root.querySelector('.summary'),
    };
    els.prog.style.strokeDasharray = String(2 * Math.PI * 44);
    els.pause.addEventListener('click', e => { e.stopPropagation(); S.paused = !S.paused; els.pause.classList.toggle('on', S.paused); });
    els.collapse.addEventListener('click', e => { e.stopPropagation(); setCollapsed(!collapsed); });
    makeDraggable();
    applyPos();
    (document.body || document.documentElement).appendChild(host);

    blocker = document.createElement('div');
    blocker.id = 'slow-down-chess-blocker';
    Object.assign(blocker.style, {
      position: 'fixed', display: 'none', zIndex: '2147482000', cursor: 'not-allowed',
      background: 'rgba(255, 70, 70, 0.10)', outline: '3px solid rgba(255,70,70,.55)', outlineOffset: '-3px',
      alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto',
    });
    const tag = document.createElement('div');
    Object.assign(tag.style, {
      font: '600 20px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', color: '#fff',
      background: 'rgba(20,20,24,.78)', padding: '10px 16px', borderRadius: '10px', textAlign: 'center', pointerEvents: 'none',
    });
    blocker.appendChild(tag);
    for (const ev of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend', 'contextmenu']) {
      blocker.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); }, { capture: true });
    }
    (document.body || document.documentElement).appendChild(blocker);
  }

  function setCollapsed(v) {
    collapsed = v;
    els.panel.classList.toggle('collapsed', v);
    els.collapse.textContent = v ? '+' : '–';
    if (hasStorage) chrome.storage.local.set({ overlayCollapsed: v });
  }

  function applyPos() {
    if (!pos) return;
    const w = els.panel.offsetWidth || 212, h = els.panel.offsetHeight || 200;
    const left = Math.min(Math.max(0, pos.left), window.innerWidth - w);
    const top = Math.min(Math.max(0, pos.top), window.innerHeight - h);
    els.panel.style.left = left + 'px'; els.panel.style.top = top + 'px'; els.panel.style.right = 'auto';
  }

  function makeDraggable() {
    let start = null;
    els.bar.addEventListener('pointerdown', e => {
      if (e.target.closest('.btn')) return;
      const r = els.panel.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      els.bar.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    els.bar.addEventListener('pointermove', e => {
      if (!start) return;
      pos = { left: start.left + e.clientX - start.x, top: start.top + e.clientY - start.y };
      applyPos();
    });
    const end = () => { if (start && hasStorage) chrome.storage.local.set({ overlayPos: pos }); start = null; };
    els.bar.addEventListener('pointerup', end);
    els.bar.addEventListener('pointercancel', end);
    window.addEventListener('resize', applyPos);
  }

  function flash(msg) { S.flashMsg = msg; S.flashUntil = Date.now() + 1800; }

  function statusInfo(now) {
    const me = S.userColor;
    if (!S.active) return { num: '—', label: 'Waiting for a game…', cls: 'idle' };
    if (S.summary) return { num: '—', label: 'Game over', cls: 'idle', summary: true };
    if (S.paused) return { num: '⏸', label: 'Paused', cls: 'idle' };
    if (S.gameOver) return { num: '—', label: 'Game over', cls: 'idle' };
    if (S.lowClock) return { num: '—', label: `Clock under ${settings.lowClockSeconds}s · counter off`, cls: 'idle' };
    const myTurn = S.turn === me;
    if (S.counterStart != null) {
      const rem = Math.max(0, S.deadline - now) / 1000;
      const frac = S.allowance ? 1 - rem / S.allowance : 1;
      const label = S.forcing === 'capture' ? 'Recapture? Check for a trap first' : S.forcing === 'check' ? 'In check · pick the best reply' : 'You can make a move in';
      if (rem > 0) return { num: rem.toFixed(1), unit: 's', frac, cls: 'wait', label };
      return { num: '✓', frac: 1, cls: 'ok', label: 'You can move now' };
    }
    if (S.turn == null) return { num: '—', label: 'Waiting for the first move…', cls: 'idle' };
    if (userMoves() + 1 < startMove()) return { num: String(userMoves() + 1), label: `Free move · countdown starts at move ${startMove()}`, cls: 'idle' };
    if (!myTurn) return { num: '—', label: "Opponent's turn", cls: 'idle' };
    return { num: '—', label: 'Your turn · no countdown yet', cls: 'idle' };
  }

  function render(now) {
    if (!host) return;
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
    if (blocker && !blocker.isConnected) (document.body || document.documentElement).appendChild(blocker);

    els.panel.classList.toggle('hidden', !settings.showOverlay);
    const info = statusInfo(now);
    const flashing = now < S.flashUntil;
    els.panel.classList.toggle('flash', flashing);
    els.panel.classList.remove('wait', 'ok', 'idle');
    els.panel.classList.add(flashing ? 'wait' : info.cls);
    els.label.textContent = flashing ? S.flashMsg : info.label;
    els.num.innerHTML = info.unit ? `${info.num}<small>${info.unit}</small>` : info.num;
    els.mini.textContent = info.unit ? `${info.num}s` : info.num;
    const C = 2 * Math.PI * 44;
    els.prog.style.strokeDashoffset = String(C * (1 - Math.min(1, Math.max(0, info.frac || 0))));

    const bits = [];
    if (S.active) {
      if (S.tc) bits.push(S.tc.label + (S.tc.guessed ? '?' : ''));
      bits.push(`${fmt(S.budget)}s/move${S.budgetSource === 'auto' ? '' : S.budgetSource === 'fixed' ? ' (fixed)' : ' (default)'}`);
      bits.push(`move ${userMoves() + 1}`);
      if (S.forcing && S.counterStart != null) bits.push(`floor ${fmt(S.allowance)}s`);
    }
    els.meta.textContent = bits.join(' · ');

    // End-of-game summary replaces the ring until the next game starts.
    const sm = S.summary;
    els.live.style.display = sm ? 'none' : '';
    els.summary.style.display = sm ? '' : 'none';
    if (sm) {
      const quickList = sm.quickMoves.length ? `Too quick on move${sm.quickMoves.length > 1 ? 's' : ''} ${sm.quickMoves.join(', ')}` : 'Never moved too quick';
      els.summary.innerHTML = sm.judged
        ? `<div class="sum-head">Game over</div>
           <div class="sum-big ${sm.tooSoon ? 'bad' : 'good'}">${sm.tooSoon} of ${sm.judged}</div>
           <div class="sum-sub">moves too quick · ${sm.pct}% on time</div>
           <div class="sum-rows">
             <div><span>Avg wait</span><b>${fmt(sm.avg)}s</b></div>
             <div><span>Fastest / slowest</span><b>${fmt(sm.fastest)}s / ${fmt(sm.slowest)}s</b></div>
             <div><span>Longest on-time streak</span><b>${sm.bestStreak}</b></div>
             <div><span>After capture / check</span><b>${sm.forcingQuick} of ${sm.forcingJudged} quick</b></div>
             <div><span>Quiet moves</span><b>${sm.quietQuick} of ${sm.quietJudged} quick</b></div>
             ${sm.avgShortfall != null ? `<div><span>Avg shortfall when quick</span><b>${fmt(sm.avgShortfall)}s</b></div>` : ''}
           </div>
           <div class="sum-list">${quickList}</div>`
        : `<div class="sum-head">Game over</div><div class="sum-sub">No moves were timed this game.</div>`;
    }

    els.m.textContent = String(S.judged);
    els.ts.textContent = String(S.tooSoon);
    const avg = S.thinkTimes.length ? S.thinkTimes.reduce((x, y) => x + y, 0) / S.thinkTimes.length : null;
    els.avg.textContent = avg == null ? '–' : fmt(avg) + 's';

    // Board blocker
    const block = settings.block && S.active && !S.paused && !S.lowClock && !S.gameOver && S.counterStart != null && now < S.deadline;
    if (block) {
      const b = adapter.findBoard();
      const r = b && b.getBoundingClientRect();
      if (r && r.width > 0) {
        blocker.style.display = 'flex';
        blocker.style.left = r.left + 'px'; blocker.style.top = r.top + 'px';
        blocker.style.width = r.width + 'px'; blocker.style.height = r.height + 'px';
        blocker.firstChild.textContent = `Wait ${((S.deadline - now) / 1000).toFixed(1)}s`;
      } else blocker.style.display = 'none';
    } else blocker.style.display = 'none';
  }

  // ---------- storage / messaging ----------
  function saveLifetime() { if (hasStorage) chrome.storage.local.set({ lifetime }); }

  function loadAll(cb) {
    if (!hasStorage) { cb(); return; }
    chrome.storage.sync.get(DEFAULTS, s => {
      settings = { ...DEFAULTS, ...s };
      chrome.storage.local.get({ lifetime, overlayPos: null, overlayCollapsed: false }, l => {
        lifetime = l.lifetime || lifetime;
        pos = l.overlayPos || null;
        collapsed = !!l.overlayCollapsed;
        cb();
      });
    });
  }

  function stats() {
    const avg = S.thinkTimes.length ? S.thinkTimes.reduce((x, y) => x + y, 0) / S.thinkTimes.length : null;
    return {
      site: adapter && adapter.name, active: S.active, paused: S.paused,
      tc: S.tc ? S.tc.label : null, budget: S.budget, budgetSource: S.budgetSource,
      nextMove: userMoves() + 1, nextAllowance: allowanceFor(userMoves() + 1),
      judged: S.judged, tooSoon: S.tooSoon, avg, lifetime, summary: S.summary, startMove: startMove(),
    };
  }

  function start() {
    loadAll(() => {
      buildOverlay();
      setCollapsed(collapsed);
      applyPos();
      if (hasStorage) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'sync') for (const k in changes) if (k in DEFAULTS) settings[k] = changes[k].newValue;
          if (area === 'local' && changes.lifetime) lifetime = changes.lifetime.newValue || { judged: 0, tooSoon: 0 };
        });
        chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
          if (!msg || !msg.type) return;
          if (msg.type === 'getStats') sendResponse(stats());
          else if (msg.type === 'resetGameStats') { S.judged = 0; S.tooSoon = 0; S.thinkTimes = []; sendResponse(stats()); }
          else if (msg.type === 'togglePause') { S.paused = !S.paused; els.pause.classList.toggle('on', S.paused); sendResponse(stats()); }
        });
      }
      setInterval(tick, 100);
    });
  }

  window.SlowDownChess = {
    parseTimeControl, parseClock,
    registerAdapter(a) { adapter = a; start(); },
  };
})();
