/*
 * Demo data source.
 *
 * Emits samples shaped like the board's SensorData_t (see
 * MCXC/.../source/CG3201FinalProject_B01_Group2.c), converted to real units:
 *
 *   {
 *     receivedAt: number,          // ms epoch when the sample arrived
 *     connected: boolean,          // link to the board is up
 *     temperature: number | null,  // °C      (temperatureX10 / 10, null if !climateValid)
 *     humidity: number | null,     // % RH    (humidityX10 / 10, null if !climateValid)
 *     light: number | null,        // lux     (null if !lightValid)
 *     lidOpen: boolean | null,     // reed switch (null if !doorValid)
 *     laserInterrupted: boolean | null,
 *   }
 *
 * A live source only needs to call onSample() with the same shape.
 */

export const DEMO_SCENARIOS = {
  normal: { label: "Normal" },
  humidity: { label: "Humidity out of range" },
  lid: { label: "Lid open" },
  laser: { label: "Laser beam interrupted" },
  offline: { label: "Disconnected" },
};

const BASELINE = {
  temperature: 21.4,
  humidity: 47.2,
  light: 38,
  lidOpen: false,
  laserInterrupted: false,
};

const TARGETS = {
  normal: {},
  humidity: { humidity: 63.5 },
  lid: { lidOpen: true, light: 96 },
  laser: { laserInterrupted: true },
  offline: {},
};

const JITTER = { temperature: 0.15, humidity: 0.4, light: 2 };
const DECIMALS = { temperature: 1, humidity: 1, light: 0 };

/* How long ago the link "dropped" when the disconnected demo starts. */
const OFFLINE_SINCE_MS = 3 * 60 * 1000 + 12 * 1000;

const HISTORY_SPAN_MS = 6 * 60 * 60 * 1000;
const HISTORY_STEP_MS = 5 * 60 * 1000;

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function jitter(metric, t) {
  const a = JITTER[metric];
  const wave = Math.sin(t / 9000) * 0.6 + Math.sin(t / 2300) * 0.4;
  return a * wave + a * 0.3 * (Math.random() - 0.5);
}

export function createDemoSource({ scenario = "normal", intervalMs = 2000, onSample }) {
  let current = DEMO_SCENARIOS[scenario] ? scenario : "normal";
  let lastSample = null;
  let timer = null;

  function liveSample(now) {
    const target = { ...BASELINE, ...TARGETS[current] };
    const sample = {
      receivedAt: now,
      connected: true,
      lidOpen: target.lidOpen,
      laserInterrupted: target.laserInterrupted,
    };

    for (const metric of Object.keys(JITTER)) {
      sample[metric] = round(target[metric] + jitter(metric, now), DECIMALS[metric]);
    }

    return sample;
  }

  function emit() {
    const now = Date.now();

    if (current === "offline") {
      /* No new data: re-emit the last known values with the link down. When the
       * page opens straight into this state, pretend the link dropped a while ago. */
      const base = lastSample ?? liveSample(now - OFFLINE_SINCE_MS);
      lastSample = { ...base, connected: false };
    } else {
      lastSample = liveSample(now);
    }

    onSample(lastSample);
  }

  function start() {
    emit();
    timer = setInterval(() => {
      if (current !== "offline") {
        emit();
      }
    }, intervalMs);
  }

  function setScenario(next) {
    if (!DEMO_SCENARIOS[next] || next === current) {
      return;
    }

    current = next;
    emit();
  }

  /* Five-minute samples over the last six hours, ending at the latest sample. */
  function history(metric) {
    const end = lastSample?.receivedAt ?? Date.now();
    const offline = lastSample && !lastSample.connected;
    const latest = lastSample?.[metric] ?? BASELINE[metric];
    const now = Date.now();
    const count = Math.floor(HISTORY_SPAN_MS / HISTORY_STEP_MS);
    const points = [];

    for (let i = 0; i <= count; i++) {
      const t = (offline ? now : end) - (count - i) * HISTORY_STEP_MS;
      const phase = { temperature: 0.4, humidity: 1.9, light: 3.1 }[metric];
      const drift =
        Math.sin(i / 11 + phase) * JITTER[metric] * 3 + Math.sin(i / 3.3 + phase) * JITTER[metric];
      let v = BASELINE[metric] + drift;

      /* Lid opened ~15 minutes ago: light steps up. */
      if (current === "lid" && metric === "light" && i >= count - 3) {
        v = latest + drift * 0.3;
      }

      /* Humidity has been climbing for the last ~40 minutes. */
      if (current === "humidity" && metric === "humidity" && i >= count - 8) {
        const k = (i - (count - 8)) / 8;
        v = BASELINE.humidity + (latest - BASELINE.humidity) * k * k + drift * 0.3;
      }

      if (i === count && !offline) {
        v = latest;
      }

      points.push({ t, v: offline && t > end ? null : round(v, DECIMALS[metric]) });
    }

    return points;
  }

  /* A few plausible events from earlier in the day. */
  function seedEvents() {
    const now = Date.now();
    const at = (minutes) => now - minutes * 60 * 1000;

    return [
      { at: at(41), kind: "resolved", text: "Lid Closed" },
      { at: at(43), kind: "ack", text: "Acknowledged: Lid open" },
      { at: at(44), kind: "caution", text: "Lid open" },
      { at: at(132), kind: "info", text: "Sensor feed connected" },
    ];
  }

  return { start, setScenario, history, seedEvents };
}
