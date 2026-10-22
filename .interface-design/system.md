# RelicGuard interface system

Implementation: `dashboard/public/` (vanilla HTML/CSS/JS, served by `dashboard/server.js`).

## Direction

A conservator's instrument panel for a card showcase. It should be calm, precise and
archival, like a museum case label next to a hygrometer. Someone glancing at it
should know in two seconds whether the cards are safe.

- **Focal point:** the status summary at the top. Its title names the active issue,
  or says "All conditions normal".
- **Normal is quiet.** Neutral surfaces, the accent only on small "ok" icons.
  Caution and breach colours appear only when something needs attention.
- **Never healthy by default.** Stale, disconnected or missing data uses its own
  "unknown" treatment (dashed borders, muted values, "Not current" text). It is
  never shown in the ok style.
- **Status is never colour alone.** Every state pairs an icon with text.

## Tokens (`styles.css :root`)

| Role | Token | Light | Dark |
|---|---|---|---|
| Page | `--board` | #F4F2ED | #16181B |
| Panel | `--board-raised` | #FBFAF7 | #1C1F22 |
| Input / hover fill | `--board-inset` | #ECE9E3 | #121416 |
| Ink, 4 tiers | `--ink` … `--ink-4` | #1C1F22 → #A0A3A6 | #E9E7E2 → #5F6062 |
| Hairlines | `--rule-soft` / `--rule` / `--rule-strong` | 7 / 12 / 22 % ink | 6 / 10 / 18 % white |
| Accent (case glass) | `--glass`, `--glass-band`, `--glass-wash` | #2B6760 | #6FB1A8 |
| Caution (amber) | `--caution` text, `--caution-mark` icon, `--caution-wash` fill, `--caution-rule` | | |
| Breach (brick) | `--breach`, `--breach-mark`, `--breach-wash`, `--breach-rule` | | |
| Unknown | `--unknown`, `--unknown-wash` | | |

Severity mapping: out of range, lid open, unknown state and feed stale/offline are
**caution**. Only an interrupted laser beam is **breach**.

## Depth, spacing, radius

- **Borders only.** Hairline rgba rules, no shadows on panels. Dialogs alone get
  `--sheet-shadow`, because they float above the page.
- 4px base unit. Panel padding 20px (mobile) / 24px (desktop). Section gaps 32px.
  List rows use 16px × 20px (alerts) and 8px × 20px (events).
- Radius scale: 6px (controls) · 10px (seal tiles, notes) · 14px (panels, dialogs).
- Page gutter is `--gutter`: 16px under 720px, 32px above. The content is at most 1240px wide.

## Typography

- IBM Plex Sans for the UI; IBM Plex Mono for timestamps and the catalogue number.
- Scale (≈1.25 ratio from 14px): 10 / 11 / 12 / 13 / 14 / 16 / 18 / 22, plus reading values
  at `clamp(36px, 4.2vw, 48px)` / 600 / −0.025em.
- Eyebrow labels: 11px / 500 / uppercase / 0.08em tracking / `--ink-3`.
- Hierarchy comes from weight and ink tier: value 600/ink, label 500/ink-2, meta 400/ink-3.
- Title Case for static headings and buttons. Live status messages use sentence case
  ("Humidity above range"). Device states use the hardware's wording ("Lid Closed",
  "Beam Intact").
- Non-breaking space between a value and its unit; word joiners around range dashes.

## Components

- **Status summary:** the panel tints to the highest severity (`data-tone` = ok / caution / breach).
  One issue shows its title and a one-line hint. Several issues show
  "N conditions need attention" and an inline list. Unconfirmed issues carry "(last known)".
- **Seal tiles (lid, laser):** a 10px × 14px tile with an eyebrow label, an icon and a
  600-weight state. When unknown it gets a dashed border and a "Last: …" sub-line.
- **Reading (signature):** label + status (icon + text) → large value + unit →
  **range rail** → "Range a–b unit [DEMO]".
  The range rail is a 6px track with the configured band drawn as an accent wash
  between 1px edges. A 3 × 18px needle marks the value and has a 2px surface ring.
  The needle is amber when out of range and hollow when the data is not current.
  The three readings share one panel, divided by hairlines (not three cards).
- **Alert row:** a 3px inset severity stripe, then icon, title, detail, and "Since <time> · <ago>".
  The Acknowledge button sits on the right. Acknowledging swaps the button for
  "Acknowledged at HH:MM · condition still active". The alert stays until live data
  shows the condition has ended.
- **Event row:** a 64px mono time column, a 14px glyph (amber, brick, teal for
  resolved, grey for info/ack), then the text.
- **Buttons:** 36px high (44px on coarse pointers), 14px horizontal padding, 6px radius,
  13px/500. Variants: default (bordered), primary (glass), quiet (borderless). Press feedback is scale(0.97).
- **Dialogs (`<dialog class="sheet">`):** 560px wide (880px for history). They open from
  the History and Thresholds buttons, which are secondary actions in the masthead,
  and are deep-linkable as `#history` / `#thresholds`.
- **History charts:** one series per chart (small multiples, not dual axes). The range band
  is drawn as an accent wash with labelled edges, the line is 2px glass, and the end dot
  has a surface ring. A crosshair tooltip appears on hover, gaps are shaded "No data",
  and there is an hourly table under "View as Table".

## Behaviour rules

- Feed state: `live` while a sample is under 10 s old; `stale` once older; `offline` when
  the board reports disconnected or nothing has arrived yet.
- Range checks only run on live data. When data is not current, every reading reads
  "Not current", and the lid and beam read "Unknown".
- Alerts clear only on live evidence. While the feed is down, existing alerts stay
  and are marked "Unconfirmed while feed is down".
- Thresholds are stored in localStorage. Validation is inline, and focus moves to the first bad field.
  All defaults are labelled demo values, not conservation standards.
