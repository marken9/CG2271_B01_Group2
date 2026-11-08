import { createLiveSource } from "./live-source.js";
import { createArmPad } from "./arm-pad.js";

const armPad = createArmPad();

/* ============================================================
 * Configuration
 * ============================================================ */

const METRICS = {
  temperature: { label: "Temperature", unit: "°C", decimals: 1, scale: [10, 35] },
  humidity: { label: "Humidity", unit: "%\u00A0RH", decimals: 1, scale: [20, 80] },
  light: { label: "Light", unit: "%", decimals: 0, scale: [0, 100] },
};

/* Starting limits for testing, not conservation standards. */
const DEFAULT_THRESHOLDS = {
  temperature: { min: 18, max: 24 },
  humidity: { min: 40, max: 55 },
  light: { min: 0, max: 60 },
};

/* A live feed with no new sample for this long is treated as stale. */
const STALE_AFTER_MS = 10_000;

const THRESHOLDS_KEY = "relicguard.thresholds.v2";
const THEME_KEY = "relicguard.theme";
const TIMESCALE_KEY = "relicguard.timescale";
const MAX_EVENTS = 50;
const VISIBLE_EVENTS = 5;

/* ============================================================
 * Formatting
 * ============================================================ */

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const shortTimeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const fmtTime = (ms) => timeFormat.format(ms);
const fmtShortTime = (ms) => shortTimeFormat.format(ms);
const fmtAgoPhrase = (ms) => (ms < 2000 ? "just now" : `${fmtAgo(ms)} ago`);

const valueFormats = Object.fromEntries(
  Object.entries(METRICS).map(([metric, { decimals }]) => [
    metric,
    new Intl.NumberFormat(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
  ]),
);

const limitFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const fmtLimit = (value) => limitFormat.format(value);

function fmtValue(metric, value) {
  return valueFormats[metric].format(value);
}

function fmtRange(metric, range) {
  const { unit } = METRICS[metric];
  /* Word joiners keep "40–55" from breaking at the dash. */
  return `${range.min}\u2060–\u2060${range.max}\u00A0${unit}`;
}

/* Durations, tight for the mono face: "12s", "3m 12s", "1h 04m". */
function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

/* ============================================================
 * Thresholds
 * ============================================================ */

function isValidRange(metric, range) {
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return false;
  if (range.min >= range.max) return false;
  if (metric === "humidity" && (range.min < 0 || range.max > 100)) return false;
  if (metric === "light" && range.min < 0) return false;
  return true;
}

function loadThresholds() {
  const thresholds = structuredClone(DEFAULT_THRESHOLDS);

  try {
    const stored = JSON.parse(localStorage.getItem(THRESHOLDS_KEY));
    for (const metric of Object.keys(METRICS)) {
      if (isValidRange(metric, stored?.[metric])) {
        thresholds[metric] = { min: stored[metric].min, max: stored[metric].max };
      }
    }
  } catch {
    /* Storage unavailable or corrupt: fall back to the defaults. */
  }

  return thresholds;
}

function saveThresholds(thresholds) {
  try {
    localStorage.setItem(THRESHOLDS_KEY, JSON.stringify(thresholds));
  } catch {
    /* Not persisted; still applied for this session. */
  }
}

/* ============================================================
 * State
 * ============================================================ */

const state = {
  sample: null,
  thresholds: loadThresholds(),
  alerts: new Map(), // key -> { key, severity, title, band, detail, since, ackAt, unconfirmed }
  events: [], // { at, kind, text }, newest first
  eventsVersion: 0,
};

function logEvent(at, kind, text) {
  addEvents([{ at, kind, text }]);
}

function addEvents(events) {
  state.events.push(...events);
  state.events.sort((a, b) => b.at - a.at);
  state.events.length = Math.min(state.events.length, MAX_EVENTS);
  state.eventsVersion++;
}

/* Lid events from the live server (kept there so they survive a reload). A
 * snapshot replaces the earlier server events. */
function applyServerEvents(events, replace) {
  if (replace) state.events = state.events.filter((event) => !event.server);
  addEvents(events.map((event) => ({ ...event, server: true })));
}

/* The server logs lid changes, so the page doesn't log them a second time.
 * Unknown-state faults are still the page's. */
const SERVER_LOGGED = new Set(["lid"]);

function pageLogs(key, severity) {
  return !(SERVER_LOGGED.has(key) && severity !== "fault");
}

/* ============================================================
 * Evaluation: sample -> current conditions
 * ============================================================ */

function feedState(sample, now) {
  if (!sample || !sample.connected) return "offline";
  if (now - sample.receivedAt > STALE_AFTER_MS) return "stale";
  return "live";
}

function readingState(value, range, feed) {
  if (value == null || !Number.isFinite(value)) return "missing";
  if (feed !== "live") return "stale";
  if (value < range.min) return "low";
  if (value > range.max) return "high";
  return "ok";
}

function evaluate(sample, now, thresholds) {
  const feed = feedState(sample, now);
  const conditions = [];

  if (feed === "offline") {
    conditions.push({
      key: "feed",
      severity: "caution",
      title: "Sensor feed disconnected",
      band: "Sensor feed disconnected · readings not current",
      detail: sample
        ? `No data received since ${fmtTime(sample.receivedAt)}. Values shown are the last known readings.`
        : "No data has been received from the showcase yet.",
      since: sample?.receivedAt,
    });
  } else if (feed === "stale") {
    conditions.push({
      key: "feed",
      severity: "caution",
      title: "Sensor data is stale",
      band: "Sensor data stale · readings not current",
      detail: `Last update at ${fmtTime(sample.receivedAt)}. Values may not reflect current conditions.`,
      since: sample.receivedAt,
    });
  }

  const readings = {};

  for (const [metric, meta] of Object.entries(METRICS)) {
    const value = sample?.[metric] ?? null;
    const range = thresholds[metric];
    const status = readingState(value, range, feed);
    readings[metric] = { value, status, range };

    if (status === "low" || status === "high") {
      const direction = status === "high" ? "above" : "below";
      conditions.push({
        key: metric,
        severity: "limit",
        title: `${meta.label} ${direction} limit`,
        band: `${meta.label} ${status} · ${direction} ${status === "high" ? range.max : range.min}`,
        detail: `Limits are ${fmtRange(metric, range)}.`,
      });
    } else if (status === "missing" && feed === "live") {
      conditions.push({
        key: metric,
        severity: "fault",
        title: `${meta.label} reading unavailable`,
        band: `${meta.label} · no valid reading`,
        detail: "The sensor did not return a valid reading.",
      });
    }
  }

  const lidOpen = sample?.lidOpen ?? null;
  const disarmed = sample?.armed === false;

  if (feed === "live") {
    if (lidOpen === true && !disarmed) {
      conditions.push({
        key: "lid",
        severity: "breach",
        title: "Lid open",
        band: "Lid open",
        detail: "The reed switch reports that the lid is open.",
        since: sample.lidOpenSince,
      });
    } else if (lidOpen === null) {
      conditions.push({
        key: "lid",
        severity: "fault",
        title: "Lid state unknown",
        band: "Lid · state unknown",
        detail: "The reed switch has not reported a state.",
      });
    }
  } else if (lidOpen === true && !disarmed) {
    /* The feed is down and the lid was last seen open: keep the alarm, even
     * after a reload, but say it can't be confirmed. */
    conditions.push({
      key: "lid",
      severity: "breach",
      title: "Lid open",
      band: "Lid open",
      detail: "The lid was open in the last reading. Its state now is unknown.",
      since: sample.lidOpenSince ?? sample.receivedAt,
      unconfirmed: true,
    });
  }

  return { feed, readings, lidOpen, disarmed, conditions };
}

const RESOLVED_TEXT = {
  feed: "Sensor feed restored",
  lid: "Lid closed",
};

/* Sync the active alert set with the current conditions and log transitions.
 * An alert only clears when live data shows the condition has ended; while the
 * feed is down, earlier alerts stay active but are marked unconfirmed. */
function reconcile(result, now) {
  const currentKeys = new Set();

  for (const condition of result.conditions) {
    currentKeys.add(condition.key);
    const existing = state.alerts.get(condition.key);

    if (!existing) {
      const since = condition.since ?? now;
      state.alerts.set(condition.key, { unconfirmed: false, ...condition, since, ackAt: null });
      if (pageLogs(condition.key, condition.severity)) logEvent(since, condition.severity, condition.title);
      continue;
    }

    if (existing.title !== condition.title && pageLogs(condition.key, condition.severity)) {
      logEvent(now, condition.severity, condition.title);
    }

    const { since, ...rest } = condition;
    Object.assign(existing, { unconfirmed: false }, rest);
  }

  for (const [key, alert] of state.alerts) {
    if (currentKeys.has(key)) continue;

    if (result.feed !== "live") {
      alert.unconfirmed = true;
      continue;
    }

    state.alerts.delete(key);
    if (!pageLogs(key, "resolved")) continue;
    const label = METRICS[key]?.label;
    logEvent(now, "resolved", RESOLVED_TEXT[key] ?? `${label} back within limits`);
  }
}

function sortedAlerts() {
  const rank = (a) => (a.severity === "breach" ? 0 : a.severity === "limit" ? 1 : a.key === "feed" ? 2 : 3);
  return [...state.alerts.values()].sort((a, b) => rank(a) - rank(b) || a.since - b.since);
}

/* ============================================================
 * Rendering
 * ============================================================ */

const $ = (selector, root = document) => root.querySelector(selector);

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function setIcon(useEl, href) {
  if (useEl.getAttribute("href") !== href) useEl.setAttribute("href", href);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/* Rebuild a container only when what it shows has changed, so live regions
 * don't chatter and focus isn't lost every second. */
function renderOnce(container, value, build) {
  const signature = JSON.stringify(value);
  if (container.dataset.signature === signature) return;
  container.dataset.signature = signature;
  container.replaceChildren(...build(value));
}

/* When the newest event with this text happened. */
function lastEventAt(text) {
  return state.events.find((event) => event.text === text)?.at;
}

/* ---------- Title row ---------- */

/* One alarm as a short line, with its reading where it has one. */
function alarmLine(alert, result) {
  const since = fmtShortTime(alert.since);
  if (alert.key === "lid") return alert.severity === "breach" ? `Lid open since ${since}` : `No lid state since ${since}`;
  const meta = METRICS[alert.key];
  const { value, status, range } = result.readings[alert.key];
  if (status === "high") return `${meta.label} ${fmtValue(alert.key, value)}\u00A0${meta.unit}, above ${fmtLimit(range.max)} since ${since}`;
  if (status === "low") return `${meta.label} ${fmtValue(alert.key, value)}\u00A0${meta.unit}, below ${fmtLimit(range.min)} since ${since}`;
  return `${meta.label}: no valid reading since ${since}`;
}

/* The screen's answer: are the cards safe? A headline, then one line of why. */
function verdict(result, now) {
  const sample = state.sample;
  if (!sample) return { tone: "warning", text: "Waiting for the first reading", detail: "Nothing has arrived from the showcase yet." };

  const lastSeen = result.lidOpen == null ? "lid state unknown" : `lid last seen ${result.lidOpen ? "open" : "closed"}`;
  if (result.feed === "offline") {
    return {
      tone: "warning",
      text: `Disconnected · ${lastSeen}`,
      detail: `No data since ${fmtShortTime(sample.receivedAt)}. Check the ESP32's power and Wi-Fi.`,
    };
  }
  if (result.feed === "stale") {
    return { tone: "warning", text: `Data stale · ${lastSeen}`, detail: `No new data for ${fmtAgo(now - sample.receivedAt)}.` };
  }

  const alerts = sortedAlerts().filter((alert) => alert.key !== "feed");
  if (alerts.length) {
    const lid = alerts.some((alert) => alert.key === "lid" && alert.severity === "breach");
    const limits = alerts.filter((alert) => alert.severity === "limit");
    const faults = alerts.filter((alert) => alert.severity === "fault");
    const readings = `${limits.length} ${limits.length === 1 ? "reading" : "readings"} out of limits`;

    let text;
    if (lid) text = limits.length ? `Lid open · ${readings}` : "Lid open";
    else if (limits.length) text = limits.length === 1 ? limits[0].title : readings;
    else text = faults.length === 1 ? faults[0].title : `${faults.length} sensors not reporting`;

    const more = alerts.length - 1;
    return {
      tone: lid || limits.length ? "negative" : "warning",
      text,
      detail: `${alarmLine(alerts[0], result)}${more ? ` · +${more} more` : ""}`,
    };
  }

  if (result.disarmed) {
    const lidText = result.lidOpen == null ? "Lid state unknown" : `Lid ${result.lidOpen ? "open" : "closed"}`;
    return { tone: "warning", text: "Alarm disarmed", detail: `${lidText} · lid not monitored` };
  }

  const closedAt = lastEventAt("Lid closed");
  return { tone: "positive", text: "Cards sealed · all within limits", detail: closedAt ? `Lid closed since ${fmtShortTime(closedAt)}` : "Lid closed" };
}

function renderVerdict(result, now) {
  const { tone, text, detail } = verdict(result, now);
  const headline = $("#verdict");
  headline.dataset.tone = tone;
  setText(headline, text);
  setText($("#finding"), detail);
  const title = `${text} · RelicGuard`;
  if (document.title !== title) document.title = title;
}

const FEED_LABEL = { live: "Live", stale: "Stale", offline: "Disconnected" };

function renderFeed(result) {
  $("#feed").dataset.feed = result.feed;
  setText($("#feed-label"), state.sample ? FEED_LABEL[result.feed] : "No data received");
  const time = $("#updated-at");
  time.hidden = !state.sample;
  if (state.sample) {
    setText(time, fmtTime(state.sample.receivedAt));
    time.dateTime = new Date(state.sample.receivedAt).toISOString();
  }
}

function unacknowledgedAlerts() {
  /* Before any data has arrived there is nothing to have seen yet. */
  if (!state.sample) return [];
  return sortedAlerts().filter((a) => a.ackAt == null);
}

function renderAckKey() {
  const count = unacknowledgedAlerts().length;
  /* aria-disabled (not disabled) so focus stays on the key after use. */
  $("#ack-all").setAttribute("aria-disabled", String(count === 0));
  setText($("#ack-label"), count ? `Acknowledge ${count}` : "Acknowledge");
}

/* ---------- Lane labels ---------- */

const READING_NOTE = {
  ok: () => "Within limits",
  high: (range) => `Above ${fmtLimit(range.max)}`,
  low: (range) => `Below ${fmtLimit(range.min)}`,
  missing: () => (state.sample ? "No valid reading" : "Waiting for first sample…"),
  stale: () => "Last known · not current",
};

function renderReadings(result) {
  for (const [metric, meta] of Object.entries(METRICS)) {
    const label = $(`.lane-label[data-metric="${metric}"]`);
    const { value, status, range } = result.readings[metric];
    label.dataset.state = status;
    setText($('[data-field="value"]', label), value == null ? "—" : fmtValue(metric, value));
    setText($('[data-field="limits"]', label), `${fmtLimit(range.min)}\u2060–\u2060${fmtLimit(range.max)}\u00A0${meta.unit}`);
    setText($('[data-field="status"]', label), READING_NOTE[status](range));
  }
}

function renderLid(result, now) {
  const label = $("#lid-label");
  const live = result.feed === "live";
  let view;
  if (live && result.disarmed) {
    const lidText = result.lidOpen == null ? "" : `Lid ${result.lidOpen ? "open" : "closed"}`;
    view = { state: "disarmed", text: "Disarmed", sub: lidText };
  } else if (live && result.lidOpen === true) {
    const alert = state.alerts.get("lid");
    view = { state: "breach", text: "Open", sub: alert ? `Open for ${fmtDuration(now - alert.since)}` : "" };
  } else if (live && result.lidOpen === false) {
    const closedAt = lastEventAt("Lid closed");
    view = { state: "secure", text: "Closed", sub: closedAt ? `Since ${fmtShortTime(closedAt)}` : "" };
  } else {
    const known = result.lidOpen;
    view = { state: "unknown", text: "Unknown", sub: known == null ? "" : `Last known ${known ? "open" : "closed"}` };
  }
  /* A real closed → open change gets the ring; loading with the lid open doesn't. */
  if (renderedLidState === "secure" && view.state === "breach") ringLid(label);
  renderedLidState = view.state;
  label.dataset.state = view.state;
  setText($('[data-field="text"]', label), view.text);
  setText($('[data-field="sub"]', label), view.sub);
}

let renderedLidState = null;

function ringLid(label) {
  label.classList.remove("lid-ring");
  void label.offsetWidth; // restart if it is somehow still running
  label.classList.add("lid-ring");
}

$("#lid-label").addEventListener("animationend", (event) => {
  if (event.animationName === "lid-ring") event.currentTarget.classList.remove("lid-ring");
});

/* ---------- Lanes: the lid and the climate on one time axis ---------- */

const PLOT_RIGHT = 40; // the y-tick lane on the right of every plot; the lid lane keeps it too
const TRACK_HEIGHT = 120;
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const MIN_WINDOW_MS = 30 * MINUTE;

/* The lid's open periods inside the window, from the event log. */
function lidSpans(result, t0, t1) {
  const spans = [];
  let open = null;
  for (let i = state.events.length - 1; i >= 0; i--) {
    const event = state.events[i];
    if (event.text === "Lid open") open = event.at;
    else if (event.text === "Lid closed" && open != null) {
      spans.push({ from: open, to: event.at });
      open = null;
    }
  }
  if (result.lidOpen === true) {
    /* Still open: runs to now while live, or to the last reading if the feed is down. */
    spans.push({ from: open ?? state.alerts.get("lid")?.since ?? t1, to: result.feed === "live" ? null : state.sample.receivedAt, ongoing: true });
  }
  return spans.filter((span) => (span.to ?? t1) >= t0).map((span) => ({ ...span, started: span.from, from: Math.max(span.from, t0) }));
}

/* Stretches this page has itself watched the lid reporting, which covers the
 * minutes the server's history hasn't caught up with yet. */
const lidSeen = [];

function noteLidSeen(result) {
  if (result.feed !== "live" || result.lidOpen === null) return;
  const at = state.sample.receivedAt;
  const last = lidSeen.at(-1);
  if (last && at - last.to < STALE_AFTER_MS) last.to = at;
  else lidSeen.push({ from: at, to: at });
}

/* Stretches of the window where the lid's state is known. The server keeps no
 * lid history, but the lid and light both come from the MCXC's status frames,
 * so light's history says when the MCXC was reporting. */
function lidCoverage(points, result) {
  let knownUntil = state.sample?.receivedAt ?? -Infinity;
  if (result.lidOpen === null) knownUntil = Math.min(knownUntil, points.at(-2).t);
  const t0 = points[0].t;
  const stretches = lidSeen.map((seen) => ({ from: Math.max(seen.from, t0), to: seen.to }));
  for (let i = 0; i < points.length - 1; i++) {
    if (points[i].v != null) stretches.push({ from: points[i].t, to: Math.min(points[i + 1].t, knownUntil) });
  }
  const merged = [];
  for (const stretch of stretches.filter((s) => s.to > s.from).sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    if (last && last.to >= stretch.from) last.to = Math.max(last.to, stretch.to);
    else merged.push({ ...stretch });
  }
  return merged;
}

/* Round ticks that always reach past both the limits and the data. */
function niceTicks(lo, hi) {
  const raw = (hi - lo || 1) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((m) => m >= raw);
  const ticks = [+(Math.floor(lo / step) * step).toFixed(6)];
  while (ticks.at(-1) < hi) ticks.push(+(ticks.at(-1) + step).toFixed(6));
  return ticks;
}

function hatch(id) {
  return `<defs><pattern id="${id}" class="t-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6"/></pattern></defs>`;
}

/* A climate track: 2px straight line, the safe band between the limits, the
 * limits dashed, round ticks on the right, a hatched gap where data stops. */
function drawTrack(plot, metric, points, reading, { t0, t1 }) {
  const w = plot.clientWidth;
  if (!w) return;
  const x1 = w - PLOT_RIGHT;
  const { range, status } = reading;
  const values = points.filter((p) => p.v != null).map((p) => p.v);
  let lo = Math.min(range.min, ...values);
  let hi = Math.max(range.max, ...values);
  const pad = (hi - lo) * 0.1 || 1;
  lo = metric === "temperature" ? lo - pad : Math.max(0, lo - pad);
  hi = metric === "humidity" ? Math.min(100, hi + pad) : hi + pad;
  const ticks = niceTicks(lo, hi);
  lo = ticks[0];
  hi = ticks.at(-1);

  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * x1;
  const y = (v) => 6 + ((hi - v) / (hi - lo)) * (TRACK_HEIGHT - 12);

  let out = `<svg viewBox="0 0 ${w} ${TRACK_HEIGHT}" height="${TRACK_HEIGHT}">${hatch(`hatch-${metric}`)}`;
  for (const tick of ticks) {
    out += `<line class="t-grid" x1="0" x2="${x1}" y1="${y(tick)}" y2="${y(tick)}"/>`;
    out += `<text class="t-tick" x="${w}" y="${y(tick) + 4}" text-anchor="end">${fmtLimit(tick)}</text>`;
  }
  const bandTop = y(Math.min(range.max, hi));
  const bandBottom = y(Math.max(range.min, lo));
  out += `<rect class="t-band" x="0" y="${bandTop}" width="${x1}" height="${Math.max(0, bandBottom - bandTop)}"/>`;
  for (const limit of [range.min, range.max]) {
    if (limit > lo && limit < hi) out += `<line class="t-limit" x1="0" x2="${x1}" y1="${y(limit)}" y2="${y(limit)}"/>`;
  }

  let d = "";
  points.forEach((p, i) => {
    if (p.v == null) return;
    const px = x(p.t).toFixed(1);
    const py = y(p.v).toFixed(1);
    const joined = points[i - 1]?.v != null;
    /* A reading with no neighbour has nothing to join to, so it's drawn as a dot. */
    if (!joined && points[i + 1]?.v == null) d += `M${Math.max(1, px - 1.25)},${py}a1.25,1.25 0 1,0 2.5,0a1.25,1.25 0 1,0 -2.5,0`;
    else d += `${joined ? "L" : "M"}${px},${py}`;
  });
  const stale = status === "stale";
  out += `<path class="t-line"${stale ? " data-stale" : ""} d="${d}"/>`;
  /* Red only on the part of the line outside the limits. */
  if (!stale) {
    out += `<clipPath id="out-${metric}"><rect x="0" y="0" width="${w}" height="${bandTop}"/><rect x="0" y="${bandBottom}" width="${w}" height="${Math.max(0, TRACK_HEIGHT - bandBottom)}"/></clipPath>`;
    out += `<path class="t-line t-line-out" clip-path="url(#out-${metric})" d="${d}"/>`;
  }

  const lastValid = points.findLastIndex((p) => p.v != null);
  if (lastValid < points.length - 1) {
    const gx = lastValid >= 0 ? x(points[lastValid].t) : 0;
    out += `<rect x="${gx}" y="0" width="${Math.max(0, x1 - gx)}" height="${TRACK_HEIGHT}" fill="url(#hatch-${metric})"/>`;
  }
  plot.innerHTML = `${out}</svg>`;
}

/* The lid lane: a green track where the lid is known, a red block for each
 * opening, and a hatched gap wherever there's no data to say either way. */
function drawLidLane(plot, result, { t0, t1 }, coverage) {
  const w = plot.clientWidth;
  if (!w) return;
  const x1 = w - PLOT_RIGHT;
  const h = 46;
  const laneTop = 18;
  const laneHeight = 22;
  const x = (t) => Math.max(0, Math.min(x1, ((t - t0) / (t1 - t0 || 1)) * x1));

  const root = svg("svg", { viewBox: `0 0 ${w} ${h}`, height: h });
  root.innerHTML = hatch("hatch-lid");
  plot.replaceChildren(root);
  const gaps = [];
  let cursor = t0;
  for (const known of coverage) {
    if (known.from > cursor) gaps.push({ from: cursor, to: known.from });
    root.append(svg("line", { class: "s-track", x1: x(known.from), x2: x(known.to), y1: laneTop + laneHeight / 2, y2: laneTop + laneHeight / 2 }));
    cursor = known.to;
  }
  if (cursor < t1) gaps.push({ from: cursor, to: t1 });
  for (const gap of gaps) {
    root.append(svg("rect", { x: x(gap.from), y: laneTop, width: Math.max(0, x(gap.to) - x(gap.from)), height: laneHeight, fill: "url(#hatch-lid)" }));
  }

  /* Labels never collide: the opening still in progress is placed first; a
   * later label that would touch one falls back to its time, or is dropped. */
  const placed = [];
  const tag = (text, at, anchor, muted = false) => {
    const node = svg("text", { class: "s-tag", x: at, y: laneTop - 5, "text-anchor": anchor });
    if (muted) node.setAttribute("data-muted", "");
    node.textContent = text;
    root.append(node);
    const box = node.getBBox();
    if (placed.some((p) => box.x < p.x + p.width + 8 && p.x < box.x + box.width + 8)) {
      node.remove();
      return false;
    }
    placed.push(box);
    return true;
  };

  const spans = lidSpans(result, t0, t1).sort((a, b) => (a.ongoing ? -1 : b.ongoing ? 1 : 0));
  for (const span of spans) {
    const a = x(span.from);
    const b = Math.max(x(span.to ?? t1), a + 3);
    root.append(svg("rect", { class: "s-block", x: a, y: laneTop, width: b - a, height: laneHeight }));
    const anchor = a > w - 150 ? "end" : "start";
    /* Labels give the real opening time, even if it's before the visible range. */
    const full = span.ongoing ? `Open since ${fmtShortTime(span.started)}` : `${fmtShortTime(span.started)} · ${fmtDuration(span.to - span.started)}`;
    tag(full, anchor === "end" ? b : a, anchor) || tag(fmtShortTime(span.started), anchor === "end" ? b : a, anchor);
  }

  for (const gap of gaps) {
    if (x(gap.to) - x(gap.from) < 60) continue;
    if (gap.to >= t1) tag("no data", x1, "end", true);
    else tag("no data", x(gap.from), "start", true);
  }
}

function drawAxis(row, { t0, t1 }) {
  const w = row.clientWidth;
  if (!w) return;
  const x1 = w - PLOT_RIGHT;
  let out = `<svg viewBox="0 0 ${w} 16" height="16">`;
  /* The finest round interval that leaves room for the labels. */
  const perMs = x1 / (t1 - t0 || 1);
  const step = [5, 10, 15, 30, 60].map((m) => m * MINUTE).find((ms) => ms * perMs >= 56) ?? 2 * HOUR;
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const at = ((t - t0) / (t1 - t0 || 1)) * x1;
    const anchor = at < 24 ? "start" : at > x1 - 20 ? "end" : "middle";
    out += `<text class="t-tick" x="${anchor === "start" ? 0 : at}" y="12" text-anchor="${anchor}">${fmtShortTime(t)}</text>`;
  }
  row.innerHTML = `${out}</svg>`;
}

let lanesKey = "";

/* The time ranges offered above the lanes, besides "auto". */
const TIMESCALES = { "30m": 30 * MINUTE, "1h": HOUR, "3h": 3 * HOUR, "6h": 6 * HOUR };

function loadTimescale() {
  try {
    const stored = localStorage.getItem(TIMESCALE_KEY);
    return Object.hasOwn(TIMESCALES, stored) ? stored : "auto";
  } catch {
    return "auto";
  }
}

let timescale = loadTimescale();

/* The range the lanes show. Auto runs from the first data to now, at least 30
 * minutes and at most six hours, so a box that has just come online isn't a
 * sliver at the edge. */
function laneWindow(histories, { t0, t1 }) {
  if (timescale !== "auto") return { t0: Math.max(t0, t1 - TIMESCALES[timescale]), t1 };
  const starts = Object.values(histories).map((points) => points.find((p) => p.v != null)?.t ?? t1);
  return { t0: Math.max(t0, Math.min(t1 - MIN_WINDOW_MS, ...starts)), t1 };
}

/* The points from t0 on, starting exactly at t0 if a line crosses into the range. */
function pointsFrom(points, t0) {
  const i = points.findIndex((p) => p.t >= t0);
  const before = points[i - 1];
  const after = points[i];
  const kept = points.slice(i);
  if (before?.v != null && after.v != null && after.t > t0) {
    kept.unshift({ t: t0, v: before.v + ((after.v - before.v) * (t0 - before.t)) / (after.t - before.t) });
  }
  return kept;
}

function renderLanes(result) {
  const width = $("#axis").clientWidth;
  const key = `${state.sample?.receivedAt}|${result.feed}|${source.historyStamp}|${state.eventsVersion}|${JSON.stringify(state.thresholds)}|${width}|${result.lidOpen}|${timescale}`;
  if (key === lanesKey) return;
  lanesKey = key;

  const histories = Object.fromEntries(Object.keys(METRICS).map((metric) => [metric, source.history(metric)]));
  const fullWindow = { t0: histories.temperature[0].t, t1: histories.temperature.at(-1).t };
  const scale = laneWindow(histories, fullWindow);
  for (const metric of Object.keys(METRICS)) {
    const points = histories[metric];
    if (result.readings[metric].status === "missing") points.at(-1).v = null;
    drawTrack($(`[data-track="${metric}"]`), metric, pointsFrom(points, scale.t0), result.readings[metric], scale);
  }
  const coverage = lidCoverage(histories.light, result);
  drawLidLane($("#lid-plot"), result, scale, coverage);
  drawAxis($("#axis"), scale);
  renderLidSummary(result, fullWindow, coverage);
}

/* How long the lid was open, over only the time there's data for. */
function renderLidSummary(result, { t0, t1 }, coverage) {
  const spans = lidSpans(result, t0, t1);
  const covered = coverage.reduce((sum, known) => sum + (known.to - known.from), 0);
  const known = covered > 0 || spans.length > 0;
  const openMs = spans.reduce((sum, span) => sum + ((span.to ?? t1) - span.from), 0);
  const span = !known || covered >= t1 - t0 - 10 * 60 * 1000 ? "last 6 h" : `in ${fmtAgo(covered)} of data`;
  renderOnce($("#lid-today"), [span, known ? fmtDuration(openMs) : "—", known ? String(spans.length) : "—"], ([window, open, count]) => [
    el("dt", null, `Lid open, ${window}`),
    el("dd", "fig", open),
    el("dt", null, `Times opened, ${window}`),
    el("dd", "fig", count),
  ]);
}

/* ---------- Side column ---------- */

function renderAlarms() {
  const alerts = sortedAlerts();
  setText($("#alarm-count"), `${alerts.length} open`);
  $(".cols").toggleAttribute("data-alarming", alerts.length > 0);
  const items = alerts.map((a) => ({
    severity: a.severity,
    title: a.title,
    sub: `${a.ackAt != null ? `Acknowledged here ${fmtShortTime(a.ackAt)} · stays until it clears` : "Not acknowledged"}${a.unconfirmed ? " · can't confirm, feed down" : ""}`,
    since: fmtShortTime(a.since),
    detail: a.detail,
  }));

  /* Keyed by title: a row stays the same element while its alarm is open and
   * only its text is updated. The hidden detail carries the live reading, so
   * rebuilding on every change would replace the rows every sample and cut off
   * their motion. */
  const list = $("#alarm-list");
  const existing = new Map([...list.children].map((li) => [li.dataset.key, li]));
  const rows = items.length
    ? items.map((item) => alarmRow(existing.get(item.title), item))
    : [existing.get("none") ?? noAlarmsRow()];
  const keep = new Set(rows);
  for (const li of [...list.children]) if (!keep.has(li)) li.remove();
  rows.forEach((li, i) => {
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] ?? null);
  });
}

function noAlarmsRow() {
  const li = el("li");
  li.dataset.key = "none";
  const note = el("p", "none");
  note.append(el("b", null, "None open"), "Nothing needs attention.");
  li.append(note);
  return li;
}

function alarmRow(li, item) {
  if (!li) {
    li = el("li");
    li.dataset.key = item.title;
    const main = el("span");
    main.append(el("span", "t"), el("small"), el("span", "visually-hidden"));
    li.append(main, el("span", "since fig"));
  }
  const title = $(".t", li);
  setText(title, item.title);
  title.dataset.severity = item.severity;
  setText($("small", li), item.sub);
  setText($(".visually-hidden", li), item.detail ? ` ${item.detail}` : "");
  setText($(".since", li), item.since);
  return li;
}

function renderSensors(result) {
  const sample = state.sample;
  const status = (valid) => {
    if (!sample) return ["Waiting", "warning"];
    if (result.feed === "offline") return [`No data since ${fmtShortTime(sample.receivedAt)}`, "warning"];
    if (result.feed === "stale") return ["Stale", "warning"];
    return valid ? ["Reporting", ""] : ["No valid reading", "warning"];
  };
  const uplink = !sample ? ["Waiting", "warning"] : result.feed === "live" ? ["Connected", ""] : [FEED_LABEL[result.feed], "warning"];
  const rows = [
    ["DHT11", "temperature, humidity", ...status(sample?.temperature != null && sample?.humidity != null)],
    ["Photoresistor", "light", ...status(sample?.light != null)],
    ["Reed switch", "lid", ...status(sample?.lidOpen != null)],
    ["ESP32", "Wi-Fi uplink", ...uplink],
  ];
  renderOnce($("#sensors"), rows, (list) =>
    list.flatMap(([name, role, text, tone]) => {
      const dt = el("dt", null, `${name} · ${role}`);
      const dd = el("dd", null, text);
      if (tone) dd.dataset.tone = tone;
      return [dt, dd];
    }),
  );
}

function eventItem(event) {
  const li = el("li", "event");
  li.dataset.kind = event.kind;
  const time = el("time", null, fmtShortTime(event.at));
  time.dateTime = new Date(event.at).toISOString();
  li.append(time, el("span", "event-text", event.text));
  return li;
}

let renderedEventsVersion = -1;

function renderEvents() {
  if (renderedEventsVersion === state.eventsVersion) return;
  renderedEventsVersion = state.eventsVersion;

  setText($("#events-all"), state.events.length > VISIBLE_EVENTS ? `All events (${state.events.length})` : "All events");
  $("#event-list").replaceChildren(
    ...(state.events.length ? state.events.slice(0, VISIBLE_EVENTS).map(eventItem) : [el("li", "event-empty", "No events yet")]),
  );
}

function update() {
  const now = Date.now();
  const result = evaluate(state.sample, now, state.thresholds);
  state.result = result;

  reconcile(result, now);
  noteLidSeen(result);
  renderVerdict(result, now);
  renderFeed(result);
  renderAckKey();
  armPad.update({ armed: state.sample?.armed ?? null, live: result.feed === "live" });
  renderReadings(result);
  renderLid(result, now);
  renderLanes(result);
  renderAlarms();
  renderSensors(result);
  renderEvents();
  animateListsOnce();
}

/* ============================================================
 * Motion: alarm and event rows
 * ============================================================ */

/* Rows enter, leave and slide; their list's height eases with them.
 *
 * The slide is an additive FLIP (composite: "add"): each layout change adds its
 * own offset animation on top of any still running, so a row that moves again
 * mid-slide carries on from where it is instead of jumping. The spring is
 * sampled into a CSS linear() easing: damping 0.72, about 4.5% overshoot. */
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const SPRING_MS = 500;
const SPRING = springEasing(0.72);
const FADE_IN_MS = 200;
const FADE_OUT_MS = 160;
const HEIGHT_MS = 320;

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/* A damped spring from 0 to 1 that settles (within 0.1%) at t = 1. */
function springEasing(damping, samples = 48) {
  const omega = Math.log(1000) / damping;
  const omegaD = omega * Math.sqrt(1 - damping * damping);
  const points = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const decay = Math.exp(-damping * omega * t);
    points.push(+(1 - decay * (Math.cos(omegaD * t) + ((damping * omega) / omegaD) * Math.sin(omegaD * t))).toFixed(4));
  }
  points[samples] = 1;
  return `linear(${points.join(", ")})`;
}

function animateList(list, keyOf) {
  const panel = list.parentElement;
  panel.style.position = "relative";
  /* Rows that have left fade out in a layer over the list, out of the renderers' way. */
  const ghosts = document.createElement(list.tagName);
  ghosts.className = `${list.className} row-ghosts`;
  ghosts.setAttribute("aria-hidden", "true");
  list.after(ghosts);

  /* Layout positions (offsetTop ignores transforms), so a running slide never
   * feeds back into the next measurement. */
  const layoutTop = (li) => li.offsetTop - list.offsetTop;
  const snapshot = () =>
    new Map(
      [...list.children].map((li) => {
        const cs = getComputedStyle(li);
        return [keyOf(li), { top: layoutTop(li), paddingTop: cs.paddingTop, borderTop: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}` }];
      }),
    );
  let before = snapshot();
  let height = list.offsetHeight;

  const enter = (li) => {
    li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_IN_MS, easing: EASE_OUT });
    if (!reducedMotion()) {
      li.animate([{ transform: "translateY(-10px) scale(0.97)" }, { transform: "none" }], {
        duration: SPRING_MS,
        easing: SPRING,
        composite: "add",
      });
    }
  };

  const leave = (node, was) => {
    for (const animation of node.getAnimations()) animation.cancel();
    delete node.dataset.key;
    /* Anchored to the list's top, so the shrinking list doesn't drag the ghost. */
    Object.assign(ghosts.style, { top: `${list.offsetTop}px`, left: `${list.offsetLeft}px`, width: `${list.offsetWidth}px` });
    Object.assign(node.style, {
      position: "absolute",
      top: `${was.top}px`,
      left: "0",
      right: "0",
      margin: "0",
      paddingTop: was.paddingTop,
      borderTop: was.borderTop,
    });
    ghosts.append(node);
    const out = reducedMotion() ? { opacity: 0 } : { opacity: 0, transform: "translateY(-4px) scale(0.97)" };
    node
      .animate([{ opacity: 1, transform: "none" }, out], { duration: FADE_OUT_MS, easing: EASE_OUT, fill: "forwards" })
      .finished.finally(() => node.remove());
  };

  const resize = () => {
    const running = list.getAnimations().find((animation) => animation.id === "height");
    const from = running ? list.getBoundingClientRect().height : height;
    running?.cancel();
    const to = list.offsetHeight;
    height = to;
    if (Math.abs(from - to) < 1 || reducedMotion()) return;
    list.style.overflow = "clip";
    const animation = list.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: HEIGHT_MS, easing: EASE_OUT });
    animation.id = "height";
    animation.finished.then(() => (list.style.overflow = ""), () => {});
  };

  new MutationObserver((records) => {
    const rows = [...list.children];
    const keys = new Set(rows.map(keyOf));

    for (const record of records) {
      for (const node of record.removedNodes) {
        if (node.nodeType !== 1) continue;
        const key = keyOf(node);
        const was = before.get(key);
        if (was && !keys.has(key)) leave(node, was);
      }
    }

    for (const li of rows) {
      const was = before.get(keyOf(li));
      if (!was) {
        enter(li);
        continue;
      }
      const dy = was.top - layoutTop(li);
      if (Math.abs(dy) < 0.5 || reducedMotion()) continue;
      li.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
        duration: SPRING_MS,
        easing: SPRING,
        composite: "add",
      });
    }

    resize();
    before = snapshot();
  }).observe(list, { childList: true });
}

/* Start once the first data has rendered, so nothing animates on page load.
 * Alarm rows keep their element while open; events are matched by their text. */
let listsAnimated = false;

function animateListsOnce() {
  if (listsAnimated || !state.sample) return;
  listsAnimated = true;
  animateList($("#alarm-list"), (li) => li.dataset.key ?? li.textContent);
  animateList($("#event-list"), (li) => li.textContent);
}

$(`#timescale input[value="${timescale}"]`).checked = true;
$("#timescale").addEventListener("change", (event) => {
  timescale = event.target.value;
  try {
    localStorage.setItem(TIMESCALE_KEY, timescale);
  } catch {
    /* Not remembered; still applied for this visit. */
  }
  if (state.result) renderLanes(state.result);
});

/* Redraw the plots when their width changes. */
new ResizeObserver(() => {
  if (state.result) renderLanes(state.result);
}).observe($("#lanes"));

/* ============================================================
 * Thresholds dialog
 * ============================================================ */

const thresholdsDialog = $("#thresholds-dialog");
const thresholdsForm = $("#thresholds-form");

function fillThresholdsForm(thresholds) {
  for (const metric of Object.keys(METRICS)) {
    thresholdsForm.elements[`${metric}-min`].value = thresholds[metric].min;
    thresholdsForm.elements[`${metric}-max`].value = thresholds[metric].max;
  }
  clearThresholdErrors();
}

function clearThresholdErrors() {
  for (const fieldset of thresholdsForm.querySelectorAll(".threshold")) {
    $(".field-error", fieldset).hidden = true;
    for (const input of fieldset.querySelectorAll("input")) input.removeAttribute("aria-invalid");
  }
}

function readThresholdsForm() {
  const values = {};
  let firstInvalid = null;

  for (const metric of Object.keys(METRICS)) {
    const fieldset = $(`.threshold[data-metric="${metric}"]`, thresholdsForm);
    const minInput = thresholdsForm.elements[`${metric}-min`];
    const maxInput = thresholdsForm.elements[`${metric}-max`];
    const range = { min: minInput.valueAsNumber, max: maxInput.valueAsNumber };
    const error = $(".field-error", fieldset);

    let message = "";
    if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) {
      message = "Enter both a minimum and a maximum.";
    } else if (range.min >= range.max) {
      message = "The minimum must be lower than the maximum.";
    } else if (!isValidRange(metric, range)) {
      message = metric === "humidity" ? "Humidity must be between 0 and 100 % RH." : "Light can’t be negative. Enter 0 or more.";
    }

    error.textContent = message;
    error.hidden = !message;
    error.id = `${metric}-error`;
    for (const input of [minInput, maxInput]) {
      if (message) {
        input.setAttribute("aria-invalid", "true");
        input.setAttribute("aria-describedby", error.id);
      } else {
        input.removeAttribute("aria-invalid");
        input.removeAttribute("aria-describedby");
      }
    }
    if (message) firstInvalid ??= Number.isFinite(range.min) ? maxInput : minInput;

    values[metric] = range;
  }

  return { values, firstInvalid };
}

thresholdsForm.addEventListener("submit", (event) => {
  if (event.submitter?.value !== "save") return;

  const { values, firstInvalid } = readThresholdsForm();
  if (firstInvalid) {
    event.preventDefault();
    firstInvalid.focus();
    return;
  }

  const changed = JSON.stringify(values) !== JSON.stringify(state.thresholds);
  state.thresholds = values;
  saveThresholds(values);
  if (changed) logEvent(Date.now(), "info", "Limits updated");
  update();
});

$("#thresholds-reset").addEventListener("click", () => fillThresholdsForm(DEFAULT_THRESHOLDS));

/* ============================================================
 * History dialog
 * ============================================================ */

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function drawChart(plot, metric, points, range) {
  const meta = METRICS[metric];
  const width = plot.clientWidth || 600;
  const height = plot.clientHeight || 140;
  const m = { top: 8, right: 12, bottom: 24, left: 44 };

  const values = points.filter((p) => p.v != null).map((p) => p.v);
  let lo = Math.min(range.min, ...values);
  let hi = Math.max(range.max, ...values);
  const pad = (hi - lo) * 0.12 || 1;
  lo = metric === "temperature" ? lo - pad : Math.max(0, lo - pad);
  hi += pad;

  const t0 = points[0].t;
  const t1 = points.at(-1).t;
  const x = (t) => m.left + ((t - t0) / (t1 - t0)) * (width - m.left - m.right);
  const y = (v) => m.top + ((hi - v) / (hi - lo)) * (height - m.top - m.bottom);
  const right = width - m.right;
  const bottom = height - m.bottom;

  const root = svg("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": `${meta.label} over the last 6 hours. Limits ${fmtRange(metric, range)}. Table view below.`,
  });

  root.append(
    svg("rect", {
      class: "chart-band",
      x: m.left,
      y: y(range.max),
      width: right - m.left,
      height: y(range.min) - y(range.max),
    }),
    svg("line", { class: "chart-band-edge", x1: m.left, x2: right, y1: y(range.max), y2: y(range.max) }),
    svg("line", { class: "chart-band-edge", x1: m.left, x2: right, y1: y(range.min), y2: y(range.min) }),
    svg("line", { class: "chart-grid", x1: m.left, x2: right, y1: bottom, y2: bottom }),
  );

  for (const v of [range.max, range.min]) {
    const label = svg("text", { class: "chart-axis", x: m.left - 8, y: y(v) + 4, "text-anchor": "end" });
    label.textContent = fmtLimit(v);
    root.append(label);
  }

  const ticks = [
    { t: t0, text: fmtShortTime(t0), anchor: "start" },
    { t: t0 + (t1 - t0) / 2, text: fmtShortTime(t0 + (t1 - t0) / 2), anchor: "middle" },
    { t: t1, text: "Now", anchor: "end" },
  ];
  for (const tick of ticks) {
    const label = svg("text", { class: "chart-axis", x: x(tick.t), y: height - 6, "text-anchor": tick.anchor });
    label.textContent = tick.text;
    root.append(label);
  }

  /* Trailing gap with no data (feed down). */
  const lastValidIndex = points.findLastIndex((p) => p.v != null);
  if (lastValidIndex >= 0 && lastValidIndex < points.length - 1) {
    const gx = x(points[lastValidIndex].t);
    root.append(svg("rect", { class: "chart-gap", x: gx, y: m.top, width: right - gx, height: bottom - m.top }));
    if (right - gx > 64) {
      const label = svg("text", { class: "chart-gap-label", x: (gx + right) / 2, y: bottom - 8, "text-anchor": "middle" });
      label.textContent = "No data";
      root.append(label);
    }
  }

  let d = "";
  let pen = false;
  for (const p of points) {
    if (p.v == null) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
    pen = true;
  }
  root.append(svg("path", { class: "chart-line", d }));
  /* Red only on the part of the line outside the limits, as on the overview. */
  const clip = svg("clipPath", { id: `chart-out-${metric}` });
  clip.append(
    svg("rect", { x: 0, y: 0, width, height: y(range.max) }),
    svg("rect", { x: 0, y: y(range.min), width, height: Math.max(0, height - y(range.min)) }),
  );
  root.append(clip, svg("path", { class: "chart-line chart-line-out", "clip-path": `url(#chart-out-${metric})`, d }));

  if (lastValidIndex >= 0) {
    const last = points[lastValidIndex];
    root.append(svg("circle", { class: "chart-dot", cx: x(last.t), cy: y(last.v), r: 4 }));
  }

  const crosshair = svg("line", { class: "chart-crosshair", y1: m.top, y2: bottom, visibility: "hidden" });
  const hoverDot = svg("circle", { class: "chart-dot", r: 4, visibility: "hidden" });
  const hitArea = svg("rect", { x: m.left, y: 0, width: right - m.left, height, fill: "transparent" });
  root.append(crosshair, hoverDot, hitArea);

  const tooltip = el("div", "chart-tooltip");
  tooltip.hidden = true;
  const tipValue = el("strong");
  const tipTime = el("span");
  tooltip.append(tipValue, tipTime);

  hitArea.addEventListener("pointermove", (event) => {
    const box = root.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    const t = t0 + ((px - m.left) / (right - m.left)) * (t1 - t0);
    let index = Math.round(((t - t0) / (t1 - t0)) * (points.length - 1));
    index = Math.min(Math.max(index, 0), points.length - 1);
    const p = points[index];
    const cx = x(p.t);

    crosshair.setAttribute("x1", cx);
    crosshair.setAttribute("x2", cx);
    crosshair.setAttribute("visibility", "visible");

    if (p.v == null) {
      hoverDot.setAttribute("visibility", "hidden");
      tipValue.textContent = "No data";
    } else {
      hoverDot.setAttribute("cx", cx);
      hoverDot.setAttribute("cy", y(p.v));
      hoverDot.setAttribute("visibility", "visible");
      tipValue.textContent = `${fmtValue(metric, p.v)}\u00A0${meta.unit}`;
    }
    tipTime.textContent = fmtShortTime(p.t);

    tooltip.hidden = false;
    const tipWidth = tooltip.offsetWidth;
    const left = Math.min(Math.max(cx + 12, 0), width - tipWidth);
    tooltip.style.left = `${cx + 12 + tipWidth > width ? cx - 12 - tipWidth : left}px`;
  });

  hitArea.addEventListener("pointerleave", () => {
    crosshair.setAttribute("visibility", "hidden");
    hoverDot.setAttribute("visibility", "hidden");
    tooltip.hidden = true;
  });

  plot.replaceChildren(root, tooltip);
}

let historyData = null;

function renderHistory() {
  const body = $("#history-body");
  historyData = Object.fromEntries(Object.keys(METRICS).map((metric) => [metric, source.history(metric)]));

  const figures = Object.entries(METRICS).map(([metric, meta]) => {
    const figure = el("figure", "chart");
    figure.dataset.metric = metric;

    const head = el("figcaption", "chart-head");
    const title = el("span", "chart-title", meta.label);
    title.append(el("span", "unit", meta.unit));
    const legend = el("span", "chart-legend");
    legend.append(el("span", "chart-legend-band"), `Limits ${fmtRange(metric, state.thresholds[metric])}`);
    head.append(title, legend);

    figure.append(head, el("div", "chart-plot"));
    return figure;
  });

  /* Hourly table view */
  const details = el("details", "history-table");
  details.append(el("summary", null, "View as Table"));
  const table = el("table");
  const thead = el("thead");
  const headRow = el("tr");
  headRow.append(el("th", null, "Time"));
  for (const meta of Object.values(METRICS)) headRow.append(el("th", null, `${meta.label} (${meta.unit})`));
  thead.append(headRow);
  table.append(thead);

  const tbody = el("tbody");
  const count = historyData.temperature.length;
  for (let i = count - 1; i >= 0; i -= 12) {
    const row = el("tr");
    row.append(el("td", null, fmtShortTime(historyData.temperature[i].t)));
    for (const metric of Object.keys(METRICS)) {
      const v = historyData[metric][i].v;
      row.append(el("td", null, v == null ? "No data" : fmtValue(metric, v)));
    }
    tbody.append(row);
  }
  table.append(tbody);
  details.append(table);

  const log = el("section", "event-log");
  log.append(el("h3", null, "Event Log"));
  const list = el("ol");
  list.append(...state.events.map(eventItem));
  log.append(state.events.length ? list : el("p", "event-empty", "No events yet"));

  body.replaceChildren(log, ...figures, details);
  drawHistoryCharts();
}

function drawHistoryCharts() {
  if (!historyData) return;
  for (const figure of document.querySelectorAll("#history-body .chart")) {
    const metric = figure.dataset.metric;
    drawChart($(".chart-plot", figure), metric, historyData[metric], state.thresholds[metric]);
  }
}

const historyDialog = $("#history-dialog");
const historyResize = new ResizeObserver(() => drawHistoryCharts());
historyDialog.addEventListener("close", () => {
  historyResize.disconnect();
  historyData = null;
});

/* ============================================================
 * Wiring
 * ============================================================ */

function openDialog(dialog) {
  if (dialog.open) return;
  if (dialog === thresholdsDialog) fillThresholdsForm(state.thresholds);
  dialog.showModal();
  if (dialog === historyDialog) {
    renderHistory();
    historyResize.observe($("#history-body"));
  }
}

/* #history and #thresholds open the matching dialog, so they can be linked. */
const DIALOG_HASHES = { "#history": historyDialog, "#thresholds": thresholdsDialog };

function openDialogFromHash() {
  const dialog = DIALOG_HASHES[location.hash];
  if (dialog) openDialog(dialog);
}

for (const [hash, dialog] of Object.entries(DIALOG_HASHES)) {
  dialog.addEventListener("close", () => {
    if (location.hash === hash) history.replaceState(null, "", location.pathname + location.search);
  });
}

window.addEventListener("hashchange", openDialogFromHash);

document.addEventListener("click", (event) => {
  /* Acknowledge records that someone has seen the alarms; each one stays in
   * the band until live data shows its condition has ended. */
  if (event.target.closest("#ack-all")) {
    const now = Date.now();
    for (const alert of unacknowledgedAlerts()) {
      alert.ackAt = now;
      logEvent(now, "ack", `Acknowledged: ${alert.title}`);
    }
    update();
  }
});

/* Theme: dark or light, remembered on this device. */
const THEME_COLOR = { dark: "#171719", light: "#f4f4f5" };

function applyTheme(theme, save) {
  document.documentElement.dataset.theme = theme;
  $('meta[name="theme-color"]').content = THEME_COLOR[theme];
  const next = theme === "dark" ? "light" : "dark";
  const toggle = $("#theme-toggle");
  toggle.setAttribute("aria-label", `Switch to ${next} mode`);
  toggle.title = `Switch to ${next} mode`;
  setIcon($("use", toggle), next === "light" ? "#i-sun" : "#i-moon");
  if (save) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* Not remembered; still applied for this visit. */
    }
  }
}

applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark", false);
$("#theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  /* Cross-fade the whole page instead of flashing it (styles.css sets the timing). */
  if (document.startViewTransition) document.startViewTransition(() => applyTheme(next, true));
  else applyTheme(next, true);
});

/* Close dialogs on backdrop click. */
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close("cancel");
  });
}

setText($("#history-sub"), "Last 6 hours · 5-minute averages");

function onSample(sample) {
  state.sample = sample;
  update();
}

const source = createLiveSource({ onSample, onEvents: applyServerEvents });
source.start();
setInterval(update, 1000);
openDialogFromHash();
