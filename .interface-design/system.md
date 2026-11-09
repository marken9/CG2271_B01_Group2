# RelicGuard interface system

Implementation: `dashboard/public/` (vanilla HTML/CSS/JS, served by `dashboard/server.js`).
Chosen direction: the "data terminal" prototype, `design-demos/taste/terminal.html`
(design-taste-frontend app style `data-terminal`, seed 966987889), with a light theme added.

## Direction

A monitoring screen left running on the bench. One time axis runs down the left panel: the
lid lane, then the temperature, humidity and light tracks, all on the same x scale, so an
event lines up with its effect (the lid opens, light jumps). Every figure is in IBM Plex Mono
so digits stack; text is Public Sans. Colour goes on data and status only.

- **The verdict comes first.** The largest text on the page answers "are the cards safe?": "Cards
  sealed · all within limits", "Lid open · 2 readings out of limits", "Disconnected · lid last seen
  open". One line under it gives the worst alarm and "+N more". It also goes in the tab title.
- **Never healthy by default.** Data that isn't current turns grey and reads "Last known · not
  current"; missing readings show "—"; the lid reads "Unknown" with its last known state; a gap
  in the feed is hatched on every lane, and the lid lane is only green where there's data for it.
- **Lid open is unmissable.** The lid's label cell gets a red border and a red wash, the word
  and its "Open for 2m 05s" counter turn red, and the lane shows a red block.
- **Acknowledging never hides anything.** Acknowledged alarms stay listed ("Acknowledged 12:14 ·
  stays until it clears") until live data clears them.
- **Status is never colour alone.** Every state also has words.

## Composition

1. **Icon rail (55px):** the mark, Overview, History (opens the history dialog with the full
   event log), Limits (opens thresholds), and the theme toggle at the bottom. The current item
   is marked by a 1px accent line on the rail's edge. On a phone it becomes a bottom bar with
   short labels.
2. **Title row:** the identity line (RelicGuard · Card Showcase · CG2271 B01 Group 2), the verdict
   (h1, 24/600, 22 on a phone), the line of why; on the right the feed (dot, Live / Stale /
   Disconnected, last sample time) and Acknowledge (quiet and aria-disabled when there is nothing to
   acknowledge).
3. **Lid and Climate panel:** a 196px label column (name and limits, the value in mono, a status
   note) beside each plot. The lid lane is a green track with red blocks for openings, labelled
   with time and duration; labels that would collide fall back to the time or are dropped.
   Tracks: a 2px line (red only where it is out of limits, grey when stale), the safe band between the
   limits in a faint green, the limits dashed, round ticks on a 40px lane at the right; a reading with no
   neighbour is a dot. Time labels run underneath. A row of radios above the lanes sets the shared
   time range: Auto (the default, from the first data to now, at least 30 minutes, at most 6 hours, so a
   box that has just come online isn't a sliver at the edge), 30 min, 1 h, 3 h or 6 h. The choice is
   saved in `localStorage` under `relicguard.timescale`.
4. **Right column (400px):** Alarms (rows, then lid-open time and count over the last 6 h),
   Recent Events (5 rows, "All events (n)" opens History), Sensors (DHT11, photoresistor, reed
   switch, ESP32 uplink, each with its state).

5. **Arm and disarm:** a quiet button beside Acknowledge ("Disarm", or "Arm" when disarmed) opens a
   narrow dialog with a D-pad: four arrows and a centre OK, like the joystick, plus arrow keys. Four dots
   count the moves and never show them. The box checks the code and only its own reported state counts
   as success. Five wrong codes lock this for 15 minutes, doubling each time; the joystick still works.

## Motion

Minimal and purposeful; nothing animates on page load, numbers and charts never animate, and
nothing loops. Curve: `--ease-out` (cubic-bezier(0.23, 1, 0.32, 1)); rows use a spring sampled into
`linear()` (damping 0.72, about 4.5% overshoot, 500ms).

- **Lid opens** (closed → open only): the cell eases to red over 240ms and one red ring goes out
  about 8px, twice (800ms each), then stops. The cell stays red without moving.
- **Alarm and event rows:** a new row fades in (200ms) while dropping 10px on the spring; a row
  that leaves fades out in place (160ms); rows that shift slide on the spring (additive FLIP, so
  interruptions carry on smoothly); the list's height eases (320ms) so the panels below glide.
  Alarm rows are keyed by title and updated in place, never rebuilt.
- **Theme switch:** a 240ms cross-fade (View Transitions).
- **Dialogs:** fade and rise in (200ms), fade out (150ms), backdrop with them.
- **Status colours** (feed, readings, finding, lid word) ease over 240ms.
- **Rail icons:** scale to 0.88 while pressed (120ms).
- **Page ends:** no bounce or stretch; the browser's own overscroll is turned off too.
- **Reduced motion:** fades only; no ring, slides, drops or height easing.

Prototype with on/off switches for each: `design-demos/motion/`.

## Tokens

Dark (default) and light share names; `<html data-theme>` picks the set. The choice is saved in
`localStorage` under `relicguard.theme` and set before first paint; without a saved choice the
system preference decides.

| Role | Dark | Light |
|---|---|---|
| Ground / surface / raised | #171719 / #131217 / #212023 | #f4f4f5 / #ffffff / #efeff1 |
| Text / muted | #ffffff / #8a8c92 | #111113 / #5f6168 |
| Accent (selection only) | #4a8ad6 | #2f6fbf |
| Positive (closed lid, safe band) | #44a282 | #1e7b4f |
| Negative (lid open, out of limits, everywhere) | #e5566f | #c4242a |
| Warning (data trust only: feed, stale) | #d9a441 | #946000 |
| Data line | #f2f2f3 | #111113 |

Panels: 6px radius; dark panels have a soft shadow and no border, light panels a 1px edge and no
shadow. One 24px gap everywhere. Type: title 26/600, panel titles 16/600, body 13 (14 on a phone),
labels 12; figures 20px mono.

## Removed

The laser tripwire was removed from the dashboard, the server and the ESP32 sketch. The server
ignores a `laserInterrupted` field if one is still sent.
