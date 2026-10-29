# CoachMate Slow Down

A Chrome extension for **lichess.org** and **chess.com** that stops you from moving too soon.
Every time your opponent moves, a countdown starts and the on-page panel says
*"You can make a move in 12.3s"*. Reply before it reaches zero and the panel flashes
**Too quick!**, buzzes, and counts the slip.

Part of [CoachMate](https://www.coachmatechess.com), the free chess notebook and trainer, and
styled with its design tokens. The extension lives in its own repo because it ships as a store
package on its own schedule.

## How the countdown is sized

Your first four moves are free. From your 5th move on (configurable), each time your
opponent moves you must wait `base time ÷ expected game length + increment` before replying.
With the default game length of 40 moves, a 10+5 game gives 15 + 5 = **20 s per move**,
3+2 gives 6.5 s, and 1+0 gives 1.5 s.

Everything above is configurable from the toolbar popup: the move the countdown starts at,
the expected game length, a fixed number of seconds instead of the formula, and a low-clock
cutoff (default 20 s) below which the countdown switches itself off.

## Forcing replies

A recapture rarely needs 20 seconds of thought, but it does need a glance for a trap or an
in-between move. So when the opponent's move was a capture (an "x" in the notation) or a
check ("+"), your reply gets a short floor instead of the full budget: 25% of the budget,
capped at 5 s and never under 1 s, so it scales with the time control (5 s in 10+5, about
1.5 s in 3+2, 1 s in bullet). Both numbers are in the popup. The panel
labels these countdowns ("Recapture? Check for a trap first") and the end-of-game summary
reports quick moves after captures or checks separately from quick quiet moves.

## End-of-game summary

When the game ends the panel switches to a summary: how many timed moves were too quick
and the percentage on time, average wait, fastest and slowest reply, longest on-time streak,
the average shortfall on the quick moves, and which move numbers were too quick. The last
50 games are kept locally and the popup lists the most recent ones.

Time control detection:

- **lichess**: read from the game header ("10+5 • Rated • Rapid").
- **chess.com**: no label is shown during a game, so the base time is taken from the
  clocks before the first move and the increment is inferred from how much the opponent's
  clock jumps after they move. The label shows a `?` until a few moves confirm it.
  Use "fixed number of seconds" in the popup if you prefer certainty.

## Install (unpacked)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder (the one containing `manifest.json`).
4. Open a game on lichess.org or chess.com. The panel appears top-right; drag its title
   bar to move it, use `–` to collapse it to a pill, and `⏸` to pause.

After editing any file, click the reload icon on the extension card and refresh the game tab.

## Options (toolbar popup)

- **Start counting at my move number** – moves before this are not timed (default 5).
- **Budget source** – from the time control (default) or a fixed number of seconds.
- **Expected game length** – the move count the base time is divided across (default 40).
- **Fixed seconds** – used in fixed mode and whenever no time control can be read (default 15).
- **Low-clock cutoff** – no countdown when your clock is under this many seconds (default 20).
- **Floor after a capture or check** – share of the budget (default 25%), capped in seconds (default 5).
- **Sounds** – a chime when the countdown ends, a buzz when you move too soon.
- **Cover the board** – optional hard mode: a transparent cover sits over the board until the
  countdown ends so a premature move is impossible. Off by default.
- Per-site on/off switches and a toggle for the on-page panel.

The popup also shows the current game's numbers (time control, budget, next move, moves judged,
too-quick count, average think time), the recent games list and an all-time tally.

## Layout

```
manifest.json          MV3 manifest
content/core.js        countdown logic, move detection, overlay, sounds, settings, stats
content/lichess.js     lichess DOM adapter (board, move list, clocks, time control)
content/chesscom.js    chess.com DOM adapter
popup/                 settings and stats popup
icons/                 toolbar icons (regenerate with: python3 scripts/make_icons.py)
```

Moves are detected from the move list's ply count, polled every 100 ms: it only grows when a
move is actually played, so stepping back and forward through the game never touches the
countdown. If no move list is on the page (zen mode), the board position is diffed instead,
guarded by a check for the highlighted current move. Both sites change their class names
from time to time; if the panel stops reacting, the selectors in the adapters are the place
to look.
