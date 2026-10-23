# RelicGuard interface system

Implementation: `dashboard/public/` (vanilla HTML/CSS/JS, served by `dashboard/server.js`).
Chosen direction: `design-demos/dir-4.html`. Its layout comes from Direction 1 (bedside
monitor) and its colours from Direction 2 (e-ink device face); see
`design-demos/direction-approved.md`.

## Direction

A bedside patient monitor printed on e-ink. Every reading is a row: a 6-hour trend on the
left, and a large numeric with its limits on the right. Alarms run in a band across the top,
coloured by priority. Controls are keys along the bottom. The page is paper and ink, and
colour appears only when something needs attention or confirms the case is sealed.

- **Never healthy by default.**
  - Data that isn't current shows **hollow ghost digits**, reads "Last known · not current",
    and has a grey trace.
  - Missing readings show "-?-" in a dashed outline.
  - Lid and laser read "Unknown" with their last known state.
- **Acknowledging never hides anything.** Acknowledged alarms change from filled to
  outlined ("Ack HH:MM · still active") and stay until live data clears them.
- **Status is never colour alone.** Every alarm and status has an icon and text.

## Composition (top to bottom)

1. **Top bar:** "RelicGuard Card Showcase", then the feed status (LIVE / STALE / DISCONNECTED,
   Updated or Last data, the time, and the age). It is closed by a 2px ink rule.
2. **Alarm band:** one block per active alert, ordered breach → feed → caution → fault.
   When nothing is active it shows "No active alarms · All readings within demo limits".
3. **Parameter rows (×3):** the trace column holds the label and a 6-hour trend with dashed
   limit lines. The numeric column (400px, 2px ink rule on its left) holds the value, the
   upper/lower limits and a status line.
4. **Lower band:** the Lid and Laser beam security cells, then the 3 most recent events.
5. **Keys:** Acknowledge (n), History, Thresholds, and the demo-data note with the demo state picker.

Responsive behaviour:
- **Short laptop screens (≤820px tall):** rows tighten so everything fits in one screen.
- **Under 900px wide:** each row stacks as label → numeric → trend, and the lower band
  becomes 2 + 1 columns.
- **Under 520px wide:** everything is a single column, and Acknowledge spans the full width.

## Tokens (`styles.css :root`)

| Role | Token | Value |
|---|---|---|
| Page | `--paper` | #E8E7E1 |
| Fills (no-alarm band, key bar, trace gaps) | `--paper-2` | #DEDDD6 |
| Inputs, chart limits band | `--paper-3` | #F2F1EC |
| Ink, 3 tiers | `--ink` / `--ink-2` / `--ink-3` | #141414 / #45443F / #5F5E58 |
| Not-current ghost | `--ghost` | #8E8D86 (decorative or large text only) |
| Hairline, limit lines | `--hair` / `--limit` | #C8C7BF / #9D9C94 |
| Secure (lid closed, no tampering, live dot) | `--secure` | #178A3E |
| Breach (high priority) | `--breach`, `--breach-wash` | #B3261E |
| Caution (medium priority) | `--caution` text, `--caution-fill`, `--caution-wash` | #9A4C05 / #C77A1C |

Alarm priorities follow patient-monitor conventions:

| Priority | Severity | Covers | Treatment |
|---|---|---|---|
| **High** | `breach` | lid open, beam tripped | filled red, white text |
| **Medium** | `caution` | out of limits, feed stale or offline | filled amber, ink text |
| **Technical** | `fault` | missing reading, unknown lid or beam state | paper fill, 2px dashed ink outline |
| **Acknowledged** | (high or medium) | any acknowledged alarm | a wash of its colour plus an outline |

## Type

Barlow for text and Barlow Semi Condensed for figures, with tabular numerals.

| Role | Spec |
|---|---|
| Numeric value | `clamp(56px, min(7.2vw, 11.5dvh), 104px)` / 600 |
| Unit | 22 / 600 / ink-2 |
| Security state | 36 / 600, uppercase (30 on short screens, 28 under 900px) |
| Parameter and section labels | 14–15 / 600, uppercase, 0.04em |
| Alarm text | 16 / 600 |
| Body, meta | 14–15 |
| Smallest label | 12 (limit "upper/lower", trace limit tags) |

## Components

- **Trace:** an SVG with a 1000×100 `viewBox` and `preserveAspectRatio="none"`, so it
  stretches to fill the row; lines use `vector-effect: non-scaling-stroke`.
  - The line is 2px ink, or ghost grey when not current.
  - Limits are 1px dashed `--limit` lines, labelled with HTML tags (so the text doesn't stretch).
  - A trailing gap with no data is shaded `--paper-2`, with "No signal" when a sensor is missing.
- **Numeric block:** the value and unit, the limits column (upper over lower), and a status
  line ("Within limits", "High · above 55 since …", "No valid reading since …" or
  "Last known · not current").
  - Out of limits: a caution wash with a 3px inset `--caution-fill` border.
  - Missing reading: a 2px dashed outline.
- **Security cell:** an uppercase label and a 30px icon with the state (green when secure).
  A breach gets a red wash and a 3px inset red border; an unknown state shows
  "Last known: …" underneath.
- **Keys:** at least 44px tall (40px on short screens), with a 2px ink border and 6px radius.
  - Acknowledge is filled amber while there are open alarms. Otherwise it uses
    `aria-disabled`, not `disabled`, so focus stays on it.
  - Pressing it acknowledges every open alarm and logs one event each.
- **Dialogs:** paper background, 2px ink border, 8px radius. The primary button is
  ink-filled. History charts use an ink line, a paper-3 limits band and dashed limit edges.

## Behaviour rules

- Feed state: `live` while a sample is under 10 s old; `stale` once older; `offline` when
  the board reports disconnected or nothing has arrived yet.
- Limit checks only run on live data. Alerts clear only on live evidence. While the feed is
  down, existing alerts stay and are marked "unconfirmed".
- Thresholds are stored in localStorage and labelled as demo values everywhere.
