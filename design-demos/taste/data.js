/*
 * Sample data for the RelicGuard prototypes. One fixed moment (3 Nov 2026, 14:55) and three states,
 * chosen with ?state=calm | alarm | offline. Everything shown on screen is computed from here: the
 * events come from the lid, beam and limit spans, so the timeline, the event log and the finding
 * line always agree.
 */
(() => {
  const MIN = 60 * 1000;
  const NOW = new Date(2026, 10, 3, 14, 55, 0).getTime();
  const STEP = 5 * MIN;
  const POINTS = 73; // 6 hours of 5-minute averages, ending now
  const START = NOW - (POINTS - 1) * STEP;
  const at = (h, m, s = 0) => new Date(2026, 10, 3, h, m, s).getTime();

  const LIMITS = {
    temperature: { min: 18, max: 24 },
    humidity: { min: 40, max: 55 },
    light: { min: 0, max: 150 },
  };

  const METRICS = {
    temperature: { label: "Temperature", unit: "°C", decimals: 1 },
    humidity: { label: "Humidity", unit: "% RH", decimals: 1 },
    light: { label: "Light", unit: "lx", decimals: 0 },
  };

  /* Deterministic noise so screenshots are stable. */
  let seed = 20261103;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

  const STATES = {
    calm: {
      lid: [{ from: at(11, 2, 4), to: at(11, 5, 16), ackAt: at(11, 3, 0) }],
      beam: [{ from: at(13, 20, 14), to: at(13, 20, 20), ackAt: at(13, 21, 0) }],
      humidityRiseFrom: null,
      feedLostAt: null,
    },
    alarm: {
      lid: [
        { from: at(11, 2, 4), to: at(11, 5, 16), ackAt: at(11, 3, 0) },
        { from: at(14, 49, 37), to: null, ackAt: null },
      ],
      beam: [{ from: at(13, 20, 14), to: at(13, 20, 20), ackAt: at(13, 21, 0) }],
      humidityRiseFrom: at(14, 5),
      feedLostAt: null,
    },
    offline: {
      lid: [{ from: at(11, 2, 4), to: at(11, 5, 16), ackAt: at(11, 3, 0) }],
      beam: [{ from: at(13, 20, 14), to: at(13, 20, 20), ackAt: at(13, 21, 0) }],
      humidityRiseFrom: null,
      feedLostAt: at(14, 41, 8),
    },
  };

  function build(name) {
    const s = STATES[name] ?? STATES.calm;
    const lidOpenAt = (t) => s.lid.some((span) => t >= span.from && (span.to == null || t < span.to));
    const live = (t) => s.feedLostAt == null || t < s.feedLostAt;

    const history = { temperature: [], humidity: [], light: [] };
    for (let i = 0; i < POINTS; i++) {
      const t = START + i * STEP;
      const ok = live(t);
      const temp = 21.4 + Math.sin(i / 11) * 0.35 + (rand() - 0.5) * 0.12;
      let hum = 47.2 + Math.sin(i / 9 + 1.9) * 0.9 + (rand() - 0.5) * 0.3;
      if (s.humidityRiseFrom != null && t >= s.humidityRiseFrom) {
        const k = (t - s.humidityRiseFrom) / (NOW - s.humidityRiseFrom);
        hum = 47.2 + (63.5 - 47.2) * k * k;
      }
      const light = lidOpenAt(t) ? 96 + (rand() - 0.5) * 4 : 38 + Math.sin(i / 7) * 1.5 + (rand() - 0.5) * 1.2;
      history.temperature.push({ t, v: ok ? +temp.toFixed(1) : null });
      history.humidity.push({ t, v: ok ? +hum.toFixed(1) : null });
      history.light.push({ t, v: ok ? Math.round(light) : null });
    }

    /* Latest reading: the last live history point (the last known one when the feed is down). */
    const lastIndex = history.temperature.findLastIndex((p) => p.v != null);
    const receivedAt = s.feedLostAt ?? NOW - 2000;
    const reading = {
      receivedAt,
      temperature: history.temperature[lastIndex].v,
      humidity: history.humidity[lastIndex].v,
      light: history.light[lastIndex].v,
      lidOpen: lidOpenAt(receivedAt - 1),
      laserInterrupted: false,
    };

    /* Limit crossings, from the history as drawn. */
    const crossings = [];
    for (const metric of Object.keys(LIMITS)) {
      const pts = history[metric];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1].v, b = pts[i].v;
        if (a == null || b == null) continue;
        if (a <= LIMITS[metric].max && b > LIMITS[metric].max) crossings.push({ metric, at: pts[i].t, dir: "high" });
      }
    }

    /* Events, newest first, derived from the spans. */
    const events = [{ at: at(8, 41, 2), kind: "info", text: "Sensor feed connected" }];
    for (const span of s.lid) {
      events.push({ at: span.from, kind: "breach", text: "Lid opened" });
      if (span.ackAt) events.push({ at: span.ackAt, kind: "ack", text: "Acknowledged: lid open" });
      if (span.to) events.push({ at: span.to, kind: "resolved", text: `Lid closed after ${duration(span.to - span.from)}` });
    }
    for (const span of s.beam) {
      events.push({ at: span.from, kind: "breach", text: "Laser beam tripped" });
      if (span.ackAt) events.push({ at: span.ackAt, kind: "ack", text: "Acknowledged: beam tripped" });
      if (span.to) events.push({ at: span.to, kind: "resolved", text: `Beam clear after ${duration(span.to - span.from)}` });
    }
    for (const c of crossings) {
      events.push({ at: c.at, kind: "caution", text: `${METRICS[c.metric].label} above ${LIMITS[c.metric].max} ${METRICS[c.metric].unit}` });
    }
    if (s.feedLostAt) events.push({ at: s.feedLostAt + 30000, kind: "caution", text: "Sensor feed lost" });
    events.sort((a, b) => b.at - a.at);

    /* Active alarms. */
    const alarms = [];
    const openLid = s.lid.find((span) => span.to == null);
    if (s.feedLostAt) {
      alarms.push({ key: "feed", severity: "caution", title: "Sensor feed lost", since: s.feedLostAt, acked: false });
    } else {
      if (openLid) alarms.push({ key: "lid", severity: "breach", title: "Lid open", since: openLid.from, acked: openLid.ackAt != null });
      for (const c of crossings) {
        const value = reading[c.metric];
        if (value > LIMITS[c.metric].max) {
          alarms.push({ key: c.metric, severity: "caution", title: `${METRICS[c.metric].label} above limit`, since: c.at, acked: false, value });
        }
      }
    }

    /* Sealed time: since the last lid or beam event ended (only meaningful when nothing is open). */
    const lastBreachEnd = Math.max(...s.lid.map((x) => x.to ?? NOW), ...s.beam.map((x) => x.to ?? NOW));
    const lastLid = s.lid.filter((x) => x.to != null).at(-1);

    /* Today's exposure, from the spans: what the alarms card shows when nothing is open. */
    const lidOpenMs = s.lid.reduce((sum, x) => sum + ((x.to ?? NOW) - x.from), 0);
    const outOfLimitsMs = crossings.reduce((sum, c) => sum + (NOW - c.at), 0);
    const today = { lidOpenMs, lidOpens: s.lid.length, beamTrips: s.beam.length, outOfLimitsMs };

    const data = {
      state: name in STATES ? name : "calm",
      now: NOW, start: START, step: STEP,
      limits: LIMITS, metrics: METRICS, history, reading, events, alarms,
      lid: s.lid, beam: s.beam, feedLostAt: s.feedLostAt,
      feed: s.feedLostAt ? "offline" : "live",
      sealedFor: openLid ? 0 : NOW - lastBreachEnd,
      today,
      /* History indices on even hours, for chart labels that land on round times. */
      evenHours: history.temperature.flatMap((p, i) => (new Date(p.t).getMinutes() === 0 && new Date(p.t).getHours() % 2 === 0 ? [i] : [])),
      lastLid,
    };

    /* Facts shown twice must agree. */
    console.assert(data.events.filter((e) => e.text === "Lid opened").length === s.lid.length, "one 'Lid opened' event per lid span");
    console.assert(data.alarms.every((a) => a.since <= NOW), "no alarm starts in the future");
    console.assert(history.temperature.length === POINTS, "six hours of 5-minute points");
    console.assert(data.evenHours.length === 3, "three even-hour labels in six hours");
    return data;
  }

  function duration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} m ${String(s % 60).padStart(2, "0")} s`;
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} m`;
  }

  const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const timeSecFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const numFmt = (d) => new Intl.NumberFormat("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d });

  const fmt = {
    time: (t) => timeFmt.format(t),
    timeSec: (t) => timeSecFmt.format(t),
    duration,
    value: (metric, v) => (v == null ? "—" : numFmt(METRICS[metric].decimals).format(v)),
    limit: (v) => numFmt(0).format(v),
  };

  /* What every prototype says, so the three agree word for word. */
  const view = {
    /* The screen's one finding, for the line under the title. */
    finding(d) {
      if (d.feed === "offline") return `No data since ${fmt.time(d.feedLostAt)}. Last known: lid closed, readings within limits.`;
      const parts = d.alarms.map((a) => (a.key === "lid" ? `Lid open since ${fmt.time(a.since)}` : `${d.metrics[a.key].label.toLowerCase()} above ${d.limits[a.key].max} ${d.metrics[a.key].unit} since ${fmt.time(a.since)}`));
      if (parts.length) return parts.join(" · ").replace(/^./, (c) => c.toUpperCase());
      return `Sealed for ${duration(d.sealedFor)}. Lid last opened ${fmt.time(d.lastLid.from)} for ${duration(d.lastLid.to - d.lastLid.from)}.`;
    },
    /* Overall status for the title pill. */
    status(d) {
      if (d.feed === "offline") return { tone: "warning", text: "Feed lost" };
      if (d.alarms.some((a) => a.severity === "breach")) return { tone: "negative", text: "Breach" };
      if (d.alarms.length) return { tone: "warning", text: "Out of limits" };
      return { tone: "positive", text: "Sealed" };
    },
    /* Lid and beam as words, with the fact that backs them. */
    seal(d) {
      const live = d.feed === "live";
      const openLid = d.lid.find((s) => s.to == null);
      const lastBeam = d.beam.at(-1);
      return {
        lid: !live
          ? { tone: "unknown", text: "Unknown", sub: "Last known closed" }
          : openLid
            ? { tone: "negative", text: "Open", sub: `Since ${fmt.timeSec(openLid.from)}` }
            : { tone: "positive", text: "Closed", sub: `Since ${fmt.time(d.lastLid.to)}` },
        beam: !live
          ? { tone: "unknown", text: "Unknown", sub: "Last known intact" }
          : { tone: "positive", text: "Intact", sub: lastBeam ? `Last tripped ${fmt.time(lastBeam.from)}` : "Not tripped today" },
      };
    },
    /* A reading against its limits. */
    reading(d, metric) {
      const v = d.reading[metric], lim = d.limits[metric];
      if (d.feed !== "live") return { tone: "unknown", text: `Last known ${fmt.time(d.feedLostAt)}` };
      if (v > lim.max) return { tone: "negative", text: `Above ${lim.max} ${d.metrics[metric].unit}` };
      if (v < lim.min) return { tone: "negative", text: `Below ${lim.min} ${d.metrics[metric].unit}` };
      return { tone: "neutral", text: "Within limits" };
    },
    /* The four sensors and what each last said. */
    sensors(d) {
      const live = d.feed === "live";
      const ok = live ? "Reporting" : `No data since ${fmt.time(d.feedLostAt)}`;
      return [
        { name: "DHT11", role: "Temperature and humidity", state: ok, tone: live ? "positive" : "warning" },
        { name: "Photoresistor", role: "Light", state: ok, tone: live ? "positive" : "warning" },
        { name: "Reed switch", role: "Lid", state: ok, tone: live ? "positive" : "warning" },
        { name: "Laser tripwire", role: "Beam", state: ok, tone: live ? "positive" : "warning" },
      ];
    },
    feed(d) {
      return d.feed === "live"
        ? { tone: "positive", text: "Live", sub: `Updated ${fmt.timeSec(d.reading.receivedAt)}` }
        : { tone: "warning", text: "Disconnected", sub: `Last data ${fmt.timeSec(d.feedLostAt)}` };
    },
  };

  const state = new URLSearchParams(location.search).get("state") || "calm";
  window.RG = { data: build(state), fmt, view };
})();
