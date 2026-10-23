import { createDemoSource, DEMO_SCENARIOS } from "./demo-source.js";

/* ============================================================
 * Configuration
 * ============================================================ */

const METRICS = {
  temperature: { label: "Temperature", unit: "°C", decimals: 1, scale: [10, 35] },
  humidity: { label: "Humidity", unit: "%\u00A0RH", decimals: 1, scale: [20, 80] },
  light: { label: "Light", unit: "lx", decimals: 0, scale: [0, 300] },
};

/* Demo values only, not conservation standards. */
const DEMO_THRESHOLDS = {
  temperature: { min: 18, max: 24 },
  humidity: { min: 40, max: 55 },
  light: { min: 0, max: 150 },
};

/* A live feed with no new sample for this long is treated as stale. */
const STALE_AFTER_MS = 10_000;

const THRESHOLDS_KEY = "relicguard.thresholds.v1";
const MAX_EVENTS = 50;
const VISIBLE_EVENTS = 3;

/* Alarm priority by severity, after patient-monitor conventions: breaches are
 * high priority, limit and feed problems medium, sensor faults technical. */
const PRIORITY = { breach: "high", caution: "medium", fault: "technical" };
const PRIORITY_ICON = { breach: "#i-breach", caution: "#i-caution", fault: "#i-unknown" };

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

function fmtValue(metric, value) {
  return valueFormats[metric].format(value);
}

function fmtRange(metric, range) {
  const { unit } = METRICS[metric];
  /* Word joiners keep "40–55" from breaking at the dash. */
  return `${range.min}\u2060–\u2060${range.max}\u00A0${unit}`;
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
  const thresholds = structuredClone(DEMO_THRESHOLDS);

  try {
    const stored = JSON.parse(localStorage.getItem(THRESHOLDS_KEY));
    for (const metric of Object.keys(METRICS)) {
      if (isValidRange(metric, stored?.[metric])) {
        thresholds[metric] = { min: stored[metric].min, max: stored[metric].max };
      }
    }
  } catch {
    /* Storage unavailable or corrupt: fall back to demo values. */
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
  state.events.unshift({ at, kind, text });
  state.events.sort((a, b) => b.at - a.at);
  state.events.length = Math.min(state.events.length, MAX_EVENTS);
  state.eventsVersion++;
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
        severity: "caution",
        title: `${meta.label} ${direction} limit`,
        band: `${meta.label} ${status} · ${direction} ${status === "high" ? range.max : range.min}`,
        detail: `Reading ${fmtValue(metric, value)}\u00A0${meta.unit}. Limits are ${fmtRange(metric, range)} (demo values).`,
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
  const laserInterrupted = sample?.laserInterrupted ?? null;

  if (feed === "live") {
    if (lidOpen === true) {
      conditions.push({
        key: "lid",
        severity: "breach",
        title: "Lid open",
        band: "Lid open",
        detail: "The reed switch reports that the lid is open.",
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

    if (laserInterrupted === true) {
      conditions.push({
        key: "laser",
        severity: "breach",
        title: "Laser beam tripped",
        band: "Laser beam tripped · possible tampering",
        detail: "Something crossed the beam inside the showcase. Possible tampering.",
      });
    } else if (laserInterrupted === null) {
      conditions.push({
        key: "laser",
        severity: "fault",
        title: "Laser state unknown",
        band: "Laser beam · state unknown",
        detail: "The beam sensor has not reported a state.",
      });
    }
  }

  return { feed, readings, lidOpen, laserInterrupted, conditions };
}

const RESOLVED_TEXT = {
  feed: "Sensor feed restored",
  lid: "Lid closed",
  laser: "Laser beam clear",
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
      state.alerts.set(condition.key, { ...condition, since, ackAt: null, unconfirmed: false });
      logEvent(since, condition.severity, condition.title);
      continue;
    }

    if (existing.title !== condition.title) {
      logEvent(now, condition.severity, condition.title);
    }

    const { since, ...rest } = condition;
    Object.assign(existing, rest, { unconfirmed: false });
  }

  for (const [key, alert] of state.alerts) {
    if (currentKeys.has(key)) continue;

    if (result.feed !== "live") {
      alert.unconfirmed = true;
      continue;
    }

    state.alerts.delete(key);
    const label = METRICS[key]?.label;
    logEvent(now, "resolved", RESOLVED_TEXT[key] ?? `${label} back within limits`);
  }
}

function sortedAlerts() {
  const rank = (a) => (a.severity === "breach" ? 0 : a.key === "feed" ? 1 : a.severity === "caution" ? 2 : 3);
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

function svgIcon(href, className = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", href);
  svg.append(use);
  return svg;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const FEED_VIEW = {
  live: { label: "Live", timeLabel: "Updated" },
  stale: { label: "Stale", timeLabel: "Last data" },
  offline: { label: "Disconnected", timeLabel: "Last data" },
};

function renderFeed(result, now) {
  const feed = $("#feed");
  feed.dataset.feed = result.feed;
  setText($("#feed-label"), state.sample ? FEED_VIEW[result.feed].label : "No data received");

  $("#feed-time").hidden = !state.sample;
  if (state.sample) {
    const updatedAt = $("#updated-at");
    setText($("#feed-time-label"), FEED_VIEW[result.feed].timeLabel);
    setText(updatedAt, fmtTime(state.sample.receivedAt));
    updatedAt.dateTime = new Date(state.sample.receivedAt).toISOString();
    setText($("#updated-ago"), fmtAgoPhrase(now - state.sample.receivedAt));
  }
}

/* Alarm band: one block per active alert, coloured by priority. Rebuilt only
 * when its content changes, so the live region doesn't chatter. */
function renderAlarms() {
  const list = $("#alarm-list");
  const alerts = sortedAlerts();

  const items = alerts.length
    ? alerts.map((a) => {
        const meta = a.ackAt != null
          ? `Ack ${fmtShortTime(a.ackAt)} · still active`
          : `since ${fmtTime(a.since)}`;
        return {
          pri: PRIORITY[a.severity],
          acked: a.ackAt != null,
          icon: PRIORITY_ICON[a.severity],
          text: a.band,
          meta: a.unconfirmed ? `${meta} · unconfirmed` : meta,
          detail: a.detail,
        };
      })
    : [{ pri: "none", icon: "#i-ok", text: "No active alarms", meta: "All readings within demo limits", detail: "" }];

  const signature = JSON.stringify(items);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;

  list.replaceChildren(
    ...items.map((item) => {
      const li = el("li", "alarm");
      li.dataset.pri = item.pri;
      li.toggleAttribute("data-acked", Boolean(item.acked));
      li.append(svgIcon(item.icon), el("span", "t", item.text), el("small", null, item.meta));
      if (item.detail) li.append(el("span", "visually-hidden", ` ${item.detail}`));
      return li;
    }),
  );
}

function unacknowledgedAlerts() {
  return sortedAlerts().filter((a) => a.ackAt == null);
}

function renderAckKey() {
  const count = unacknowledgedAlerts().length;
  const key = $("#ack-all");
  /* aria-disabled (not disabled) so focus stays on the key after use. */
  key.setAttribute("aria-disabled", String(count === 0));
  setText($("#ack-label"), count ? `Acknowledge (${count})` : "Acknowledge");
}

const READING_STATUS = {
  ok: () => ({ icon: "#i-ok", text: "Within limits" }),
  high: (range, alert) => ({ icon: "#i-up", text: `High · above ${range.max} since ${fmtTime(alert.since)}` }),
  low: (range, alert) => ({ icon: "#i-down", text: `Low · below ${range.min} since ${fmtTime(alert.since)}` }),
  missing: (range, alert) => ({
    icon: "#i-unknown",
    text: alert ? `No valid reading since ${fmtTime(alert.since)}` : state.sample ? "No valid reading" : "Waiting for first sample",
  }),
  stale: () => ({ icon: "#i-offline", text: "Last known · not current" }),
};

function renderParams(result) {
  for (const metric of Object.keys(METRICS)) {
    const row = $(`.param[data-metric="${metric}"]`);
    const { value, status, range } = result.readings[metric];
    const view = READING_STATUS[status](range, state.alerts.get(metric));

    row.dataset.state = status;
    setText($('[data-field="value"]', row), value == null ? "-?-" : fmtValue(metric, value));
    setText($('[data-field="max"]', row), String(range.max));
    setText($('[data-field="min"]', row), String(range.min));
    setIcon($(".status use", row), view.icon);
    setText($('[data-field="status"]', row), view.text);
  }
}

/* 6-hour trend per reading, drawn in a stretched 1000×100 viewBox so it fills
 * the row at any width; labels are HTML so they don't stretch. */
function drawTrace(plot, metric, points, range, status) {
  const values = points.filter((p) => p.v != null).map((p) => p.v);
  let lo = Math.min(range.min, ...values);
  let hi = Math.max(range.max, ...values);
  const pad = (hi - lo) * 0.15 || 1;
  lo = metric === "temperature" ? lo - pad : Math.max(0, lo - pad);
  hi += pad;

  const x = (i) => (i / (points.length - 1)) * 1000;
  const y = (v) => ((hi - v) / (hi - lo)) * 100;

  const root = svg("svg", { viewBox: "0 0 1000 100", preserveAspectRatio: "none" });
  const lastValid = points.findLastIndex((p) => p.v != null);
  if (lastValid >= 0 && lastValid < points.length - 1) {
    root.append(svg("rect", { class: "trace-gap", x: x(lastValid), y: 0, width: 1000 - x(lastValid), height: 100 }));
  }

  const tags = [];
  for (const limit of [range.max, range.min]) {
    if (limit <= lo) continue;
    root.append(svg("line", { class: "trace-limit", x1: 0, x2: 1000, y1: y(limit), y2: y(limit), "vector-effect": "non-scaling-stroke" }));
    const tag = el("span", "trace-tag", String(limit));
    tag.style.top = `${y(limit)}%`;
    tags.push(tag);
  }

  let d = "";
  let pen = false;
  points.forEach((p, i) => {
    if (p.v == null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(2)}`;
    pen = true;
  });
  root.append(svg("path", { class: "trace-line", d, "vector-effect": "non-scaling-stroke" }));

  if (status === "missing" && lastValid >= 0) {
    const label = el("span", "trace-nosignal", "No signal");
    label.style.left = `${(x(lastValid) + 1000) / 20}%`;
    tags.push(label);
  }

  plot.replaceChildren(root, ...tags);
}

let tracedKey = "";

function renderTraces(result) {
  const key = `${state.sample?.receivedAt}|${result.feed}|${JSON.stringify(state.thresholds)}`;
  if (key === tracedKey) return;
  tracedKey = key;

  for (const metric of Object.keys(METRICS)) {
    const { status, range } = result.readings[metric];
    const points = source.history(metric);
    if (status === "missing") points.at(-1).v = null;
    drawTrace($(`.param[data-metric="${metric}"] .trace-plot`), metric, points, range, status);
  }
}

function renderSecurity(result) {
  const live = result.feed === "live";

  renderSeal($("#seal-lid"), live, result.lidOpen, {
    on: { state: "breach", icon: "#i-lid-open", text: "Open", sub: "Reed switch" },
    off: { state: "secure", icon: "#i-lid-closed", text: "Closed", sub: "Reed switch" },
    lastOn: "open",
    lastOff: "closed",
  });

  const tripped = state.alerts.get("laser");
  renderSeal($("#seal-laser"), live, result.laserInterrupted, {
    on: {
      state: "breach",
      icon: "#i-beam-broken",
      text: "Tripped",
      sub: tripped ? `Since ${fmtTime(tripped.since)} · possible tampering` : "Possible tampering",
    },
    off: { state: "secure", icon: "#i-beam", text: "No tampering", sub: "Beam intact" },
    lastOn: "tripped",
    lastOff: "no tampering",
  });
}

function renderSeal(sec, live, value, variants) {
  let view;
  if (live && value !== null) {
    view = value ? variants.on : variants.off;
  } else {
    const sub = value === null ? "" : `Last known: ${value ? variants.lastOn : variants.lastOff}`;
    view = { state: "unknown", icon: "#i-unknown", text: "Unknown", sub };
  }

  sec.dataset.state = view.state;
  setIcon($(".sec-state use", sec), view.icon);
  setText($('[data-field="text"]', sec), view.text);
  setText($('[data-field="sub"]', sec), view.sub);
}

let renderedEventsVersion = -1;

function renderEvents() {
  if (renderedEventsVersion === state.eventsVersion) return;
  renderedEventsVersion = state.eventsVersion;

  $("#event-list").replaceChildren(
    ...state.events.slice(0, VISIBLE_EVENTS).map((event) => {
      const li = el("li", "event");
      const time = el("time", "num", fmtTime(event.at));
      time.dateTime = new Date(event.at).toISOString();
      li.append(time, el("span", "event-text", event.text));
      return li;
    }),
  );
}

function update() {
  const now = Date.now();
  const result = evaluate(state.sample, now, state.thresholds);

  reconcile(result, now);
  renderFeed(result, now);
  renderAlarms();
  renderAckKey();
  renderParams(result);
  renderTraces(result);
  renderSecurity(result);
  renderEvents();
}

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
      message = metric === "humidity" ? "Humidity must be between 0 and 100 % RH." : "Light cannot be negative.";
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
  if (changed) logEvent(Date.now(), "info", "Thresholds updated");
  update();
});

$("#thresholds-reset").addEventListener("click", () => fillThresholdsForm(DEMO_THRESHOLDS));

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
    label.textContent = String(v);
    root.append(label);
  }

  const ticks = [
    { t: t0, text: "6 h ago", anchor: "start" },
    { t: t0 + (t1 - t0) / 2, text: "3 h ago", anchor: "middle" },
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
    legend.append(el("span", "chart-legend-band"), `Limits ${fmtRange(metric, state.thresholds[metric])} (demo)`);
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

  body.replaceChildren(...figures, details);
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
  const opener = event.target.closest("[data-open]");
  if (opener) {
    openDialog(document.getElementById(opener.dataset.open));
    return;
  }

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

/* Close dialogs on backdrop click. */
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close("cancel");
  });
}

/* Demo state picker (also settable with ?demo=<state>) */
const demoSelect = $("#demo-state");
const params = new URLSearchParams(location.search);
const initialScenario = DEMO_SCENARIOS[params.get("demo")] ? params.get("demo") : "normal";

for (const [value, { label }] of Object.entries(DEMO_SCENARIOS)) {
  const option = el("option", null, label);
  option.value = value;
  demoSelect.append(option);
}
demoSelect.value = initialScenario;

demoSelect.addEventListener("change", () => {
  const url = new URL(location.href);
  if (demoSelect.value === "normal") url.searchParams.delete("demo");
  else url.searchParams.set("demo", demoSelect.value);
  history.replaceState(null, "", url);
  source.setScenario(demoSelect.value);
});

/* Replace this with a live source (polling or streaming from server.js)
 * once the board is connected. It only needs to call onSample(sample). */
const source = createDemoSource({
  scenario: initialScenario,
  onSample(sample) {
    state.sample = sample;
    update();
  },
});

for (const event of source.seedEvents()) logEvent(event.at, event.kind, event.text);
source.start();
setInterval(update, 1000);
openDialogFromHash();
