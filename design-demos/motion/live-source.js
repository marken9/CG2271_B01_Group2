/*
 * Simulated live source for the motion prototypes.
 *
 * Same interface as dashboard/public/live-source.js, so app.js is the real one,
 * unchanged. Instead of a server it plays a board that posts every 2 s, and
 * exposes window.sim so the prototype panel can open the lid, push humidity over
 * its limit or drop the feed.
 */

const STEP = 5 * 60 * 1000;
const POINTS = 73;
const MIN = 60 * 1000;

export function createLiveSource({ onSample, onEvents }) {
  const target = { temperature: 21.4, humidity: 47.2, light: 22, lidOpen: false };
  let lidOpenSince = null;
  let connected = true;
  let latest = null;
  let historyStamp = 0;

  const jitter = (a, t) => a * (Math.sin(t / 9000) * 0.6 + Math.sin(t / 2300) * 0.4);

  function sample(now) {
    return {
      receivedAt: now,
      connected: true,
      temperature: +(target.temperature + jitter(0.15, now)).toFixed(1),
      humidity: +(target.humidity + jitter(0.4, now)).toFixed(1),
      light: Math.round(target.light + jitter(1.5, now)),
      lidOpen: target.lidOpen,
      lidOpenSince,
    };
  }

  function emit() {
    if (!connected) return;
    latest = sample(Date.now());
    onSample(latest);
  }

  function start() {
    const now = Date.now();
    onEvents(
      [
        { at: now - 132 * MIN, kind: "info", text: "Sensor feed connected" },
        { at: now - 44 * MIN, kind: "breach", text: "Lid open" },
        { at: now - 41 * MIN, kind: "resolved", text: "Lid closed" },
      ],
      true,
    );
    emit();
    setInterval(emit, 2000);
  }

  function history(metric) {
    const end = latest?.receivedAt ?? Date.now();
    const base = { temperature: 21.4, humidity: 47.2, light: 22 }[metric];
    const amp = { temperature: 0.35, humidity: 1, light: 2 }[metric];
    const points = [];
    for (let i = 0; i < POINTS - 1; i++) {
      const t = end - (POINTS - 1 - i) * STEP;
      let v = base + Math.sin(i / 10 + base) * amp;
      if (metric === "light" && i >= POINTS - 10 && i <= POINTS - 9) v = 70;
      points.push({ t, v: +v.toFixed(metric === "light" ? 0 : 1) });
    }
    points.push(connected && latest ? { t: latest.receivedAt, v: latest[metric] } : { t: Date.now(), v: null });
    return points;
  }

  /* Controls for the prototype panel. */
  window.sim = {
    setLid(open) {
      if (target.lidOpen === open) return;
      const now = Date.now();
      target.lidOpen = open;
      target.light = open ? 74 : 22;
      lidOpenSince = open ? now : null;
      onEvents([{ at: now, kind: open ? "breach" : "resolved", text: open ? "Lid open" : "Lid closed" }], false);
      emit();
    },
    setHumid(high) {
      target.humidity = high ? 61.8 : 47.2;
      emit();
    },
    setConnected(on) {
      connected = on;
      historyStamp++;
      if (on) emit();
      else if (latest) onSample({ ...latest, connected: false });
    },
    get lidOpen() {
      return target.lidOpen;
    },
    get connected() {
      return connected;
    },
  };

  return {
    start,
    history,
    get historyStamp() {
      return historyStamp;
    },
  };
}
