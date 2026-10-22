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
const VISIBLE_EVENTS = 8;

const SEVERITY_ICON = { caution: "#i-caution", breach: "#i-breach" };
const EVENT_ICON = {
  caution: "#i-caution",
  breach: "#i-breach",
  resolved: "#i-resolved",
  ack: "#i-ack",
  info: "#i-dot",
};

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

function fmtValue(metric, value) {
  return value.toFixed(METRICS[metric].decimals);
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
  alerts: new Map(), // key -> { key, severity, title, detail, hint, since, ackAt, unconfirmed }
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
      detail: sample
        ? `No data received since ${fmtTime(sample.receivedAt)}. Values shown are the last known readings.`
        : "No data has been received from the showcase yet.",
      hint: "Readings, lid and beam status are not current.",
      since: sample?.receivedAt,
    });
  } else if (feed === "stale") {
    conditions.push({
      key: "feed",
      severity: "caution",
      title: "Sensor data is stale",
      detail: `Last update at ${fmtTime(sample.receivedAt)}. Values may not reflect current conditions.`,
      hint: "Readings, lid and beam status are not current.",
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
        title: `${meta.label} ${direction} range`,
        detail: `${fmtValue(metric, value)}\u00A0${meta.unit} against a range of ${fmtRange(metric, range)} (demo).`,
        hint: `${meta.label} is ${direction} the configured range.`,
      });
    } else if (status === "missing" && feed === "live") {
      conditions.push({
        key: metric,
        severity: "caution",
        title: `${meta.label} reading unavailable`,
        detail: "The sensor did not return a valid reading.",
        hint: `${meta.label} cannot be checked.`,
      });
    }
  }

  const lidOpen = sample?.lidOpen ?? null;
  const laserInterrupted = sample?.laserInterrupted ?? null;

  if (feed === "live") {
    if (lidOpen === true) {
      conditions.push({
        key: "lid",
        severity: "caution",
        title: "Lid open",
        detail: "The reed switch reports that the lid is open.",
        hint: "The showcase lid is open.",
      });
    } else if (lidOpen === null) {
      conditions.push({
        key: "lid",
        severity: "caution",
        title: "Lid state unknown",
        detail: "The reed switch has not reported a state.",
        hint: "The lid state cannot be checked.",
      });
    }

    if (laserInterrupted === true) {
      conditions.push({
        key: "laser",
        severity: "breach",
        title: "Laser beam interrupted",
        detail: "Something is crossing the beam inside the showcase.",
        hint: "The laser beam is interrupted.",
      });
    } else if (laserInterrupted === null) {
      conditions.push({
        key: "laser",
        severity: "caution",
        title: "Laser state unknown",
        detail: "The beam sensor has not reported a state.",
        hint: "The beam cannot be checked.",
      });
    }
  }

  return { feed, readings, lidOpen, laserInterrupted, conditions };
}

const RESOLVED_TEXT = {
  feed: "Sensor feed restored",
  lid: "Lid Closed",
  laser: "Laser beam restored",
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
    logEvent(now, "resolved", RESOLVED_TEXT[key] ?? `${label} back within range`);
  }
}

function sortedAlerts() {
  const rank = (a) => (a.severity === "breach" ? 0 : a.key === "feed" ? 1 : 2);
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

function renderFeed(result, now) {
  const pill = $("#feed-pill");
  const labels = { live: "Live", stale: "Stale data", offline: "Disconnected" };
  const icons = { live: "#i-dot", stale: "#i-caution", offline: "#i-offline" };

  pill.dataset.feed = result.feed;
  setIcon($("use", pill), icons[result.feed]);
  setText($("#feed-label"), labels[result.feed]);

  const updatedAt = $("#updated-at");
  if (state.sample) {
    setText(updatedAt, fmtTime(state.sample.receivedAt));
    updatedAt.dateTime = new Date(state.sample.receivedAt).toISOString();
    setText($("#updated-ago"), `· ${fmtAgoPhrase(now - state.sample.receivedAt)}`);
  } else {
    setText(updatedAt, "—");
    setText($("#updated-ago"), "");
  }
}

function renderSummary(result) {
  const alerts = sortedAlerts();
  const summary = $("#summary");
  const issues = $("#summary-issues");

  let tone = "ok";
  if (alerts.length) tone = alerts.some((a) => a.severity === "breach") ? "breach" : "caution";
  summary.dataset.tone = tone;
  setIcon($("#summary-icon"), tone === "ok" ? "#i-ok" : SEVERITY_ICON[tone]);

  let title;
  let detail = "";

  if (!alerts.length) {
    title = "All conditions normal";
    detail = "Readings within range · Lid Closed · Beam Intact";
  } else if (alerts.length === 1) {
    title = alerts[0].title;
    detail = alerts[0].unconfirmed
      ? "Last known condition. It cannot be confirmed while the feed is down."
      : alerts[0].hint;
  } else {
    title = `${alerts.length} conditions need attention`;
  }

  setText($("#summary-title"), title);
  setText($("#summary-detail"), detail);

  const signature = alerts.length > 1
    ? alerts.map((a) => `${a.key}:${a.title}:${a.unconfirmed}`).join("|")
    : "";

  if (issues.dataset.signature !== signature) {
    issues.dataset.signature = signature;
    issues.replaceChildren(
      ...(alerts.length > 1 ? alerts : []).map((a) => {
        const li = el("li");
        li.dataset.severity = a.severity;
        li.append(svgIcon(SEVERITY_ICON[a.severity]), document.createTextNode(a.title));
        if (a.unconfirmed) li.append(el("span", "issue-note", " (last known)"));
        return li;
      }),
    );
  }

  /* Lid + laser seals */
  const live = result.feed === "live";

  renderSeal($("#seal-lid"), live, result.lidOpen, {
    on: { state: "caution", icon: "#i-lid-open", text: "Lid Open" },
    off: { state: "ok", icon: "#i-lid-closed", text: "Lid Closed" },
    lastOn: "Open",
    lastOff: "Closed",
  });

  renderSeal($("#seal-laser"), live, result.laserInterrupted, {
    on: { state: "breach", icon: "#i-beam-broken", text: "Beam Interrupted" },
    off: { state: "ok", icon: "#i-beam", text: "Beam Intact" },
    lastOn: "Interrupted",
    lastOff: "Intact",
  });
}

function renderSeal(seal, live, value, variants) {
  let view;

  if (live && value !== null) {
    view = { ...(value ? variants.on : variants.off), sub: "" };
  } else {
    const last = value === null ? "" : `Last: ${value ? variants.lastOn : variants.lastOff}`;
    view = { state: "unknown", icon: "#i-unknown", text: "Unknown", sub: last };
  }

  seal.dataset.state = view.state;
  setIcon($("use", seal), view.icon);
  setText($('[data-field="text"]', seal), view.text);

  let sub = $(".seal-sub", seal);
  if (view.sub && !sub) {
    sub = el("span", "seal-sub");
    $("dd", seal).append(sub);
  }
  if (sub) setText(sub, view.sub);
}

const READING_STATUS = {
  ok: { text: "Within range", icon: "#i-ok" },
  low: { text: "Below range", icon: "#i-caution" },
  high: { text: "Above range", icon: "#i-caution" },
  stale: { text: "Not current", icon: "#i-unknown" },
  missing: { text: "No reading", icon: "#i-unknown" },
};

function railPercent(value, lo, hi) {
  return `${(Math.min(Math.max((value - lo) / (hi - lo), 0), 1) * 100).toFixed(2)}%`;
}

function renderReadings(result, now) {
  for (const [metric, meta] of Object.entries(METRICS)) {
    const card = $(`.reading[data-metric="${metric}"]`);
    const { value, status, range } = result.readings[metric];
    const view = READING_STATUS[status];

    card.dataset.state = status;
    setIcon($(".reading-status use", card), view.icon);
    setText($('[data-field="status"]', card), view.text);
    setText($('[data-field="value"]', card), value == null ? "—" : fmtValue(metric, value));
    setText($('[data-field="range"]', card), fmtRange(metric, range));

    const lo = Math.min(meta.scale[0], range.min);
    const hi = Math.max(meta.scale[1], range.max);
    const rail = $(".rail", card);
    rail.style.setProperty("--lo", railPercent(range.min, lo, hi));
    rail.style.setProperty("--hi", railPercent(range.max, lo, hi));
    if (value != null) rail.style.setProperty("--pos", railPercent(value, lo, hi));

    let note = "";
    if (status === "stale" && state.sample) {
      note = `Last known value · ${fmtAgoPhrase(now - state.sample.receivedAt)}`;
    } else if (status === "missing") {
      note = state.sample ? "The sensor did not return a valid reading." : "Waiting for the first sample.";
    }
    setText($('[data-field="note"]', card), note);
  }
}

const alertNodes = new Map();

function buildAlertNode(key) {
  const li = el("li", "alert");
  li.tabIndex = -1;
  li.dataset.key = key;

  const icon = svgIcon("#i-caution");
  const body = el("div", "alert-body");
  const title = el("p", "alert-title");
  const detail = el("p", "alert-detail");
  const meta = el("p", "alert-meta");
  const time = el("time");
  const ago = el("span");
  const unconfirmed = el("span");
  meta.append("Since ", time, " · ", ago, unconfirmed);
  body.append(title, detail, meta);

  const actions = el("div", "alert-actions");
  li.append(icon, body, actions);

  return li;
}

function renderAlertActions(li, alert) {
  const actions = $(".alert-actions", li);
  const acked = alert.ackAt != null;

  if (li.dataset.acked === String(acked)) return;
  li.dataset.acked = String(acked);

  if (acked) {
    /* Acknowledging only records that someone has seen it; the alert stays
     * listed until the condition itself clears. */
    const note = el("p", "alert-ack-note");
    note.append(
      svgIcon("#i-ack"),
      `Acknowledged at ${fmtShortTime(alert.ackAt)} · condition still active`,
    );
    actions.replaceChildren();
    $(".alert-body", li).append(note);
  } else {
    const button = el("button", "btn", "Acknowledge");
    button.type = "button";
    button.dataset.ack = alert.key;
    button.setAttribute("aria-label", `Acknowledge: ${alert.title}`);
    actions.replaceChildren(button);
  }
}

function renderAlerts(now) {
  const list = $("#alert-list");
  const alerts = sortedAlerts();
  const keys = new Set(alerts.map((a) => a.key));

  for (const [key, node] of alertNodes) {
    if (!keys.has(key)) {
      node.remove();
      alertNodes.delete(key);
    }
  }

  alerts.forEach((alert, index) => {
    let li = alertNodes.get(alert.key);
    if (!li) {
      li = buildAlertNode(alert.key);
      alertNodes.set(alert.key, li);
    }

    li.dataset.severity = alert.severity;
    setIcon($("use", li), SEVERITY_ICON[alert.severity]);
    setText($(".alert-title", li), alert.title);
    setText($(".alert-detail", li), alert.detail);

    const [time, ago, unconfirmed] = $(".alert-meta", li).querySelectorAll("time, span");
    setText(time, fmtTime(alert.since));
    time.dateTime = new Date(alert.since).toISOString();
    setText(ago, fmtAgoPhrase(now - alert.since));
    setText(unconfirmed, alert.unconfirmed ? " · Unconfirmed while feed is down" : "");

    renderAlertActions(li, alert);

    if (list.children[index] !== li) {
      list.insertBefore(li, list.children[index] ?? null);
    }
  });

  const count = $("#alert-count");
  setText(count, String(alerts.length));
  count.toggleAttribute("data-active", alerts.length > 0);
  $("#alert-empty").hidden = alerts.length > 0;
}

let renderedEventsVersion = -1;

function renderEvents() {
  if (renderedEventsVersion === state.eventsVersion) return;
  renderedEventsVersion = state.eventsVersion;

  const list = $("#event-list");
  list.replaceChildren(
    ...state.events.slice(0, VISIBLE_EVENTS).map((event) => {
      const li = el("li", "event");
      li.dataset.kind = event.kind;
      const time = el("time", "num", fmtTime(event.at));
      time.dateTime = new Date(event.at).toISOString();
      li.append(time, svgIcon(EVENT_ICON[event.kind]), el("span", "event-text", event.text));
      return li;
    }),
  );
}

function update() {
  const now = Date.now();
  const result = evaluate(state.sample, now, state.thresholds);

  reconcile(result, now);
  renderFeed(result, now);
  renderSummary(result);
  renderReadings(result, now);
  renderAlerts(now);
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
    "aria-label": `${meta.label} over the last 6 hours. Range ${fmtRange(metric, range)}. Table view below.`,
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
    legend.append(el("span", "chart-legend-band"), `Range ${fmtRange(metric, state.thresholds[metric])} (demo)`);
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

  const ack = event.target.closest("[data-ack]");
  if (ack) {
    const alert = state.alerts.get(ack.dataset.ack);
    if (alert && alert.ackAt == null) {
      alert.ackAt = Date.now();
      logEvent(alert.ackAt, "ack", `Acknowledged: ${alert.title}`);
      update();
      alertNodes.get(alert.key)?.focus();
    }
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
