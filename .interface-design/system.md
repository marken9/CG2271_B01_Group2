# RelicGuard interface system

Implementation: `dashboard/public/` (vanilla HTML/CSS/JS, served by `dashboard/server.js`).
Chosen direction: the "data terminal" prototype, `design-demos/taste/terminal.html`
(design-taste-frontend app style `data-terminal`, seed 966987889), with a light theme added.

## Direction

A monitoring screen left running on the bench. One time axis runs down the left panel: the
lid lane, then the temperature, humidity and light tracks, all on the same x scale, so an
event lines up with its effect (the lid opens, light jumps). Every figure is in IBM Plex Mono
so digits stack; text is Public Sans. Colour goes on data and status only.

- **The finding comes first.** The line under the title says what matters now ("Lid open
  since 12:12", "Humidity above 55 % RH since 14:40", "No data since 14:41").
- **Never healthy by default.** Data that isn't current turns grey and reads "Last known · not
  current"; missing readings show "—"; the lid reads "Unknown" with its last known state; a gap
  in the feed is hatched on every lane.
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
2. **Title row:** "RelicGuard · CG2271 B01 Group 2", the h1 "Card Showcase" (plus a "Demo data"
   tag in demo mode), the finding line; on the right the Data picker, the feed (dot, Live /
   Stale / Disconnected, last sample time) and Acknowledge as an inverted pill (quiet and
   aria-disabled when there is nothing to acknowledge).
3. **Lid and Climate panel:** a 196px label column (name and limits, the value in mono, a status
   note) beside each plot. The lid lane is a green track with red blocks for openings, labelled
   with time and duration; labels that would collide fall back to the time or are dropped.
   Tracks: a 2px line (red when out of limits, grey when stale), the safe band between the
   limits in a faint green, the limits dashed, round ticks on a 40px lane at the right. Hour
   labels run underneath.
4. **Right column (400px):** Alarms (rows, then lid-open time and count over the last 6 h),
   Recent Events (5 rows, "All events (n)" opens History), Sensors (DHT11, photoresistor, reed
   switch, ESP32 uplink, each with its state).

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
| Negative (lid open, out of limits) | #e5566f | #c4242a |
| Warning (feed, stale) | #d9a441 | #92400e |
| Data line | #f2f2f3 | #111113 |

Panels: 6px radius; dark panels have a soft shadow and no border, light panels a 1px edge and no
shadow. One 24px gap everywhere. Type: title 26/600, panel titles 16/600, body 13 (14 on a phone),
labels 12; figures 20px mono.

## Removed

The laser tripwire was removed from the dashboard, the server and the ESP32 sketch. The server
ignores a `laserInterrupted` field if one is still sent.
