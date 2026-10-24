/*
 * RelicGuard dashboard server.
 *
 *   GET  /               the dashboard (static files in ./public)
 *   GET  /healthz        health check for Render and the keep-alive pinger
 *   POST /api/readings   one reading from the ESP32 (Bearer INGEST_TOKEN)
 *   GET  /api/stream     Server-Sent Events: a snapshot, then each new reading
 *
 * Environment: PORT, INGEST_TOKEN (required to accept readings), and
 * optionally DATABASE_URL (Postgres, e.g. Supabase) to keep history across
 * restarts. See README.md.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.js";

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = resolve(fileURLToPath(new URL("./public", import.meta.url)));

const INGEST_TOKEN = process.env.INGEST_TOKEN || "";
const MAX_BODY_BYTES = 2048;
const MAX_STREAM_CLIENTS = 100;
const HEARTBEAT_MS = 20_000;
const TICK_MS = 5_000;

/* The board counts as offline after this long without a reading. */
const BOARD_TIMEOUT_MS = 30_000;

/* Plausible ranges; anything outside is rejected as a bad reading. */
const READING_LIMITS = {
  temperature: [-40, 85],
  humidity: [0, 100],
  light: [0, 200_000],
};
const READING_FLAGS = ["lidOpen", "laserInterrupted"];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

/* Resolve a URL path to a file inside PUBLIC_DIR, or null if it escapes. */
function resolvePublicPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  const relative = normalize(decoded).replace(/^[/\\]+/, "");
  const filePath = join(PUBLIC_DIR, relative || "index.html");

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    return null;
  }

  return filePath;
}

async function serveStatic(req, res, pathname) {
  let filePath = resolvePublicPath(pathname);

  if (filePath === null) {
    send(res, 400, "Bad request", { "Content-Type": "text/plain" });
    return;
  }

  try {
    if ((await stat(filePath)).isDirectory()) {
      filePath = join(filePath, "index.html");
    }

    const info = await stat(filePath);
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    /* Assets are not fingerprinted, so always revalidate (cheap with ETag). */
    const headers = { "Cache-Control": "no-cache", ETag: etag };

    if (req.headers["if-none-match"] === etag) {
      send(res, 304, undefined, headers);
      return;
    }

    const body = await readFile(filePath);
    const type = MIME_TYPES[extname(filePath)] || "application/octet-stream";

    send(res, 200, req.method === "HEAD" ? undefined : body, { ...headers, "Content-Type": type });
  } catch {
    send(res, 404, "Not found", { "Content-Type": "text/plain" });
  }
}

function sendJson(res, status, body) {
  send(res, status, body === undefined ? undefined : JSON.stringify(body), {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
}

/* ---------- Readings ---------- */

const store = createStore({ databaseUrl: process.env.DATABASE_URL });
const streams = new Set();
let boardOnline = false;

const digest = (value) => createHash("sha256").update(value).digest();
const tokenDigest = INGEST_TOKEN ? digest(INGEST_TOKEN) : null;

function authorised(req) {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  return Boolean(tokenDigest && match && timingSafeEqual(digest(match[1]), tokenDigest));
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      /* Past the limit, keep draining (so the 413 reaches the client) but drop the data. */
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        reject(Object.assign(new Error("Body too large"), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* Returns { reading } or { error }. Missing fields mean "no valid reading". */
function parseReading(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { error: "Body must be JSON" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "Body must be a JSON object" };
  }

  const reading = {};
  for (const [field, [min, max]] of Object.entries(READING_LIMITS)) {
    const value = data[field] ?? null;
    if (value !== null && !(typeof value === "number" && value >= min && value <= max)) {
      return { error: `${field} must be a number from ${min} to ${max}, or null` };
    }
    reading[field] = value;
  }
  for (const field of READING_FLAGS) {
    const value = data[field] ?? null;
    if (value !== null && typeof value !== "boolean") {
      return { error: `${field} must be true, false or null` };
    }
    reading[field] = value;
  }
  return { reading };
}

function broadcast(type, payload) {
  const message = `event: ${type}\ndata: ${JSON.stringify({ now: Date.now(), ...payload })}\n\n`;
  for (const res of streams) res.write(message);
}

async function handleReading(req, res) {
  if (!INGEST_TOKEN) {
    sendJson(res, 503, { error: "Ingest is disabled: set INGEST_TOKEN on the server" });
    return;
  }
  if (!authorised(req)) {
    sendJson(res, 401, { error: "Missing or wrong token" });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    sendJson(res, error.status ?? 400, { error: error.message });
    return;
  }

  const { reading, error } = parseReading(body);
  if (error) {
    sendJson(res, 400, { error });
    return;
  }

  const { sample, events } = store.add(reading);
  boardOnline = true;
  broadcast("sample", { sample, events, boardOnline });
  sendJson(res, 204);
}

function handleStream(req, res) {
  if (streams.size >= MAX_STREAM_CLIENTS) {
    send(res, 503, "Too many viewers", { "Content-Type": "text/plain", "Retry-After": "30" });
    return;
  }

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const snapshot = {
    now: Date.now(),
    boardOnline,
    sample: store.latest,
    history: store.history(),
    events: store.events,
  };
  res.write(`retry: 5000\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

  streams.add(res);
  req.on("close", () => streams.delete(res));
}

/* Every few seconds: close finished minutes, notice a silent board, and keep
 * idle streams open through proxies. */
let lastHeartbeat = Date.now();
const ticker = setInterval(() => {
  const now = Date.now();

  if (store.tick(now)) broadcast("history", { history: store.history(now) });

  const online = Boolean(store.latest && now - store.latest.receivedAt < BOARD_TIMEOUT_MS);
  if (online !== boardOnline) {
    boardOnline = online;
    broadcast("status", { boardOnline });
  }

  if (now - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = now;
    for (const res of streams) res.write(": ping\n\n");
  }
}, TICK_MS);

/* ---------- Routing ---------- */

const ROUTES = {
  "/healthz": {
    GET: (req, res) => sendJson(res, 200, { ok: true }),
    HEAD: (req, res) => send(res, 200, undefined, { "Cache-Control": "no-store" }),
  },
  "/api/readings": { POST: handleReading },
  "/api/stream": { GET: handleStream },
};

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  const route = ROUTES[pathname];
  const handlers = route ?? { GET: serveStatic, HEAD: serveStatic };
  const handler = handlers[req.method];

  if (!handler) {
    send(res, 405, "Method not allowed", {
      "Content-Type": "text/plain",
      Allow: Object.keys(handlers).join(", "),
    });
    return;
  }

  try {
    await handler(req, res, pathname);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: "Internal error" });
  }
});

try {
  await store.init();
} catch (error) {
  console.error("Database unavailable; keeping readings in memory only.", error);
}

server.listen(PORT, () => {
  const storage = store.persistent ? "with database" : "in memory only";
  const ingest = INGEST_TOKEN ? "accepting readings" : "readings disabled (no INGEST_TOKEN)";
  console.log(`RelicGuard dashboard on http://localhost:${PORT} · ${ingest} · ${storage}`);
});

/* Render sends SIGTERM before a restart or redeploy: save the current minute. */
async function shutdown() {
  clearInterval(ticker);
  for (const res of streams) res.end();
  server.close();
  await store.close();
  process.exit(0);
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
