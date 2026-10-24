/*
 * Reading store.
 *
 * Keeps the latest sample, six hours of one-minute averages and the recent
 * lid/laser events in memory. When DATABASE_URL is set, minute averages and
 * events are also written to Postgres (e.g. Supabase) and reloaded on start,
 * so a restart or redeploy doesn't wipe the trends or the event log.
 */

import pg from "pg";

const MINUTE_MS = 60 * 1000;
const BUCKET_MS = 5 * MINUTE_MS;
const HISTORY_BUCKETS = 72; // 6 hours of 5-minute buckets
const HISTORY_SPAN_MS = HISTORY_BUCKETS * BUCKET_MS;
const MAX_EVENTS = 50;

export const METRICS = ["temperature", "humidity", "light"];

/* Lid and laser transitions are logged here, not in the browser, so anyone
 * opening the page later still sees them. Texts match the page's alert titles. */
const SECURITY = {
  lid: { field: "lidOpen", on: "Lid open", off: "Lid closed" },
  laser: { field: "laserInterrupted", on: "Laser beam tripped", off: "Laser beam clear" },
};

const SCHEMA = `
  create schema if not exists relicguard;

  create table if not exists relicguard.readings_minute (
    minute timestamptz primary key,
    temperature real,
    humidity real,
    light real,
    samples integer not null
  );

  create table if not exists relicguard.events (
    id bigserial primary key,
    at timestamptz not null,
    subject text not null,
    kind text not null,
    text text not null
  );

  create index if not exists events_at_idx on relicguard.events (at desc);

  -- Not exposed through Supabase's Data API; RLS as a second guard.
  alter table relicguard.readings_minute enable row level security;
  alter table relicguard.events enable row level security;
`;

function emptyMinute(t) {
  return { t, sums: {}, counts: {}, samples: 0 };
}

function minuteAverages(minute) {
  const averages = {};
  for (const metric of METRICS) {
    averages[metric] = minute.counts[metric] ? minute.sums[metric] / minute.counts[metric] : null;
  }
  return averages;
}

/* Connection options for pg. SSL settings in the URL are taken out because pg
 * would let them override the ssl option below. */
function connectionOptions(databaseUrl) {
  const url = new URL(databaseUrl);
  const sslmode = url.searchParams.get("sslmode");
  for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(key);

  /* Supabase's pooler certificate is signed by Supabase's own CA. Paste that CA
   * (Database settings → SSL) into DATABASE_CA to verify it; otherwise the
   * connection is encrypted but the server certificate isn't checked.
   * sslmode=disable is for a local test database only. */
  const ca = process.env.DATABASE_CA?.replaceAll("\\n", "\n");
  const ssl = sslmode === "disable" ? false : ca ? { ca } : { rejectUnauthorized: false };

  return { connectionString: url.toString(), ssl, max: 3 };
}

export function createStore({ databaseUrl, onError = console.error } = {}) {
  const pool = databaseUrl ? new pg.Pool(connectionOptions(databaseUrl)) : null;

  pool?.on("error", onError);

  let latest = null;
  let current = null; // minute being accumulated
  const minutes = []; // completed minutes: { t, temperature, humidity, light, samples }
  const events = []; // newest first: { at, kind, text }
  const security = {
    lid: { on: null, since: null },
    laser: { on: null, since: null },
  };

  async function query(text, values) {
    if (!pool) return null;
    try {
      return await pool.query(text, values);
    } catch (error) {
      onError(error);
      return null;
    }
  }

  async function init() {
    if (!pool) return;

    await pool.query(SCHEMA);

    const since = new Date(Date.now() - HISTORY_SPAN_MS);
    const rows = await pool.query(
      "select minute, temperature, humidity, light, samples from relicguard.readings_minute where minute > $1 order by minute",
      [since],
    );
    for (const row of rows.rows) {
      minutes.push({
        t: row.minute.getTime(),
        temperature: row.temperature,
        humidity: row.humidity,
        light: row.light,
        samples: row.samples,
      });
    }

    const recent = await pool.query(
      "select at, kind, text from relicguard.events order by at desc limit $1",
      [MAX_EVENTS],
    );
    events.push(...recent.rows.map((row) => ({ at: row.at.getTime(), kind: row.kind, text: row.text })));

    /* Carry the open/tripped state across restarts so it isn't logged twice. */
    const last = await pool.query(
      "select distinct on (subject) subject, at, kind from relicguard.events order by subject, at desc",
    );
    for (const row of last.rows) {
      if (!security[row.subject]) continue;
      const on = row.kind === "breach";
      security[row.subject] = { on, since: on ? row.at.getTime() : null };
    }
  }

  function closeMinute() {
    if (!current || current.samples === 0) return null;
    const done = { t: current.t, ...minuteAverages(current), samples: current.samples };
    minutes.push(done);
    current = null;

    while (minutes.length && minutes[0].t <= Date.now() - HISTORY_SPAN_MS) minutes.shift();

    return query(
      `insert into relicguard.readings_minute (minute, temperature, humidity, light, samples)
       values ($1, $2, $3, $4, $5)
       on conflict (minute) do update set temperature = excluded.temperature,
         humidity = excluded.humidity, light = excluded.light, samples = excluded.samples`,
      [new Date(done.t), done.temperature, done.humidity, done.light, done.samples],
    );
  }

  /* Close the current minute once the clock has moved past it. Returns true if
   * the history changed. */
  function tick(now = Date.now()) {
    if (current && now - current.t >= MINUTE_MS) {
      closeMinute();
      return true;
    }
    return false;
  }

  function logEvent(at, subject, kind, text) {
    const event = { at, kind, text };
    events.unshift(event);
    events.length = Math.min(events.length, MAX_EVENTS);
    query("insert into relicguard.events (at, subject, kind, text) values ($1, $2, $3, $4)", [
      new Date(at),
      subject,
      kind,
      text,
    ]);
    return event;
  }

  /* Record a validated reading. Returns the stored sample and any new events. */
  function add(reading, now = Date.now()) {
    const minuteStart = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    if (current && current.t !== minuteStart) closeMinute();
    current ??= emptyMinute(minuteStart);

    current.samples++;
    for (const metric of METRICS) {
      const value = reading[metric];
      if (value == null) continue;
      current.sums[metric] = (current.sums[metric] ?? 0) + value;
      current.counts[metric] = (current.counts[metric] ?? 0) + 1;
    }

    const newEvents = [];
    for (const [subject, { field, on, off }] of Object.entries(SECURITY)) {
      const value = reading[field];
      const state = security[subject];
      if (value == null || value === state.on) continue;

      /* A first "closed"/"clear" reading is just the starting state. */
      if (value) {
        newEvents.push(logEvent(now, subject, "breach", on));
      } else if (state.on) {
        newEvents.push(logEvent(now, subject, "resolved", off));
      }
      security[subject] = { on: value, since: value ? now : null };
    }

    latest = {
      receivedAt: now,
      ...reading,
      lidOpenSince: reading.lidOpen ? security.lid.since : null,
      laserSince: reading.laserInterrupted ? security.laser.since : null,
    };

    return { sample: latest, events: newEvents };
  }

  /* Five-minute averages over the last six hours, oldest first, with null for
   * buckets that have no data. The last bucket includes the current minute. */
  function history(now = Date.now()) {
    const end = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    const start = end - (HISTORY_BUCKETS - 1) * BUCKET_MS;
    const sums = METRICS.map(() => new Float64Array(HISTORY_BUCKETS));
    const weights = METRICS.map(() => new Float64Array(HISTORY_BUCKETS));

    const accumulate = (t, values, weight) => {
      const i = Math.floor((t - start) / BUCKET_MS);
      if (i < 0 || i >= HISTORY_BUCKETS) return;
      METRICS.forEach((metric, m) => {
        if (values[metric] == null) return;
        sums[m][i] += values[metric] * weight;
        weights[m][i] += weight;
      });
    };

    for (const minute of minutes) accumulate(minute.t, minute, minute.samples);
    if (current?.samples) accumulate(current.t, minuteAverages(current), current.samples);

    const result = {};
    METRICS.forEach((metric, m) => {
      result[metric] = Array.from({ length: HISTORY_BUCKETS }, (_, i) => ({
        t: start + i * BUCKET_MS,
        v: weights[m][i] ? sums[m][i] / weights[m][i] : null,
      }));
    });
    return result;
  }

  async function close() {
    await closeMinute();
    await pool?.end();
  }

  return {
    init,
    add,
    tick,
    history,
    close,
    get latest() {
      return latest;
    },
    get events() {
      return events;
    },
    persistent: Boolean(pool),
  };
}
