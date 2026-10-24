/*
 * Live data source.
 *
 * Streams readings from server.js (GET /api/stream, Server-Sent Events) and
 * calls onSample() with the same shape as demo-source.js, plus:
 *
 *   lidOpenSince, laserSince: number | null   // when the lid opened / beam tripped
 *
 * The server keeps the lid/laser event log so it survives reloads; those
 * events arrive through onEvents(events, replace).
 */

const BUCKET_MS = 5 * 60 * 1000;
const HISTORY_BUCKETS = 72;
const RETRY_MS = 10_000;

function emptyHistory(now) {
  const end = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  return Array.from({ length: HISTORY_BUCKETS }, (_, i) => ({
    t: end - (HISTORY_BUCKETS - 1 - i) * BUCKET_MS,
    v: null,
  }));
}

export function createLiveSource({ url = "api/stream", onSample, onEvents }) {
  let stream = null;
  let streamOpen = false;
  let boardOnline = false;
  let latest = null;
  let buckets = null;
  let historyStamp = 0;

  /* Server times are moved onto this browser's clock, so a device whose clock
   * is a few seconds off doesn't see live data as stale. */
  let offset = 0;
  const local = (t) => (t == null ? null : t + offset);

  function toSample(sample) {
    if (!sample) return null;
    return {
      ...sample,
      receivedAt: local(sample.receivedAt),
      lidOpenSince: local(sample.lidOpenSince),
      laserSince: local(sample.laserSince),
    };
  }

  const toEvents = (events) => events.map((event) => ({ ...event, at: local(event.at) }));

  function setHistory(history) {
    buckets = Object.fromEntries(
      Object.entries(history).map(([metric, points]) => [metric, points.map((p) => ({ t: local(p.t), v: p.v }))]),
    );
    historyStamp++;
  }

  function emit() {
    onSample(latest && { ...latest, connected: streamOpen && boardOnline });
  }

  function listen(type, handler) {
    stream.addEventListener(type, (event) => {
      const message = JSON.parse(event.data);
      offset = Date.now() - message.now;
      handler(message);
      emit();
    });
  }

  function start() {
    stream = new EventSource(url);

    listen("snapshot", (message) => {
      streamOpen = true;
      boardOnline = message.boardOnline;
      latest = toSample(message.sample);
      setHistory(message.history);
      onEvents(toEvents(message.events), true);
    });

    listen("sample", (message) => {
      boardOnline = message.boardOnline;
      latest = toSample(message.sample);
      if (message.events.length) onEvents(toEvents(message.events), false);
    });

    listen("history", (message) => setHistory(message.history));

    listen("status", (message) => {
      boardOnline = message.boardOnline;
    });

    stream.addEventListener("error", () => {
      streamOpen = false;
      emit();
      /* EventSource retries by itself unless the server refused the stream. */
      if (stream.readyState === EventSource.CLOSED) {
        setTimeout(start, RETRY_MS);
      }
    });
  }

  /* Five-minute averages for the last six hours, then the latest reading (or
   * an empty point at "now" while the feed is down, so the gap shows). */
  function history(metric) {
    const points = (buckets?.[metric] ?? emptyHistory(Date.now())).map((p) => ({ ...p }));
    const live = latest && streamOpen && boardOnline;
    points.push(live ? { t: latest.receivedAt, v: latest[metric] } : { t: Date.now(), v: null });
    return points;
  }

  return {
    start,
    history,
    get historyStamp() {
      return historyStamp;
    },
  };
}
