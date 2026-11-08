/*
 * RelicGuard dashboard server.
 *
 *   GET  /               the dashboard (static files in ./public)
 *   GET  /healthz        health check for Render and the keep-alive pinger
 *   POST /api/readings   one reading from the ESP32 (Bearer INGEST_TOKEN)
 *   GET  /api/stream     Server-Sent Events: a snapshot, then each new reading
 *   GET  /api/arm        the online arm/disarm lockout state
 *   POST /api/arm        relay an arm code to the box and wait for its answer
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
const READING_FLAGS = ["lidOpen", "armed"];

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

  const commandResult = data.commandResult ?? null;
  if (commandResult !== null && !(Number.isInteger(commandResult.id) && Number.isInteger(commandResult.result))) {
    return { error: "commandResult must have integer id and result" };
  }
  return { reading, commandResult };
}

function broadcast(type, payload) {
  const message = `event: ${type}\ndata: ${JSON.stringify({ now: Date.now(), ...payload })}\n\n`;
  for (const res of streams) res.write(message);
}

/* ---------- Arming and disarming from the dashboard ----------
 * The server only relays the code; the MCXC checks it, and the code is never
 * stored, logged or put on the public stream. The code space is small (256),
 * so wrong codes lock this route out. The joystick is unaffected. */

const ARM_CODE = /^[UDLR]{4}$/;
const ARM_DELIVERY_MS = 10_000; // how long the ESP32 has to collect a command
const ARM_CONFIRM_MS = 15_000; // then how long the box has to confirm it
const ARM_MAX_WRONG = 5;
const ARM_LOCK_MS = 15 * 60_000; // the first lockout; each one after doubles
const ARM_LOCK_MAX_MS = 24 * 60 * 60_000;

/* Results the ESP32 reports back (rg_protocol.h, rg_esp_uart.h). */
const RESULT_APPLIED = 0;
const RESULT_WRONG_CODE = 5;
const RESULT_NOT_SENT = -3;

const ARM_STATUS = { applied: 200, wrong: 403, busy: 409, locked: 429, rejected: 502, offline: 503, unknown: 504 };

/* One at a time: { id, target, code (null once collected), accepted, res, timer }. */
let armCommand = null;
let nextCommandId = Math.floor(Date.now() / 1000); // doesn't repeat across restarts

function armStatus(now = Date.now()) {
  const guard = store.armGuard;
  return { lockedForMs: Math.max(0, guard.lockedUntil - now), attemptsLeft: ARM_MAX_WRONG - guard.wrong };
}

function finishArm(outcome) {
  const { res, timer } = armCommand;
  armCommand = null;
  clearTimeout(timer);
  sendJson(res, ARM_STATUS[outcome], { outcome, ...armStatus() });
}

/* Returns the events to announce. */
function recordWrongCode(now) {
  const guard = store.armGuard;
  const events = [store.logEvent(now, "system", "breach", "Wrong alarm code entered")];
  guard.wrong++;
  if (guard.wrong >= ARM_MAX_WRONG) {
    const lockMs = Math.min(ARM_LOCK_MS * 2 ** guard.lockouts, ARM_LOCK_MAX_MS);
    guard.wrong = 0;
    guard.lockouts++;
    guard.lockedUntil = now + lockMs;
    events.push(store.logEvent(now, "system", "breach", `Online alarm control locked for ${lockMs / 60_000} min`));
  }
  store.saveArmGuard();
  return events;
}

/* The ESP32's answer for a command it collected. Returns the events to announce. */
function applyCommandResult({ id, result }) {
  if (armCommand?.id !== id || armCommand.code !== null) return [];
  if (result === RESULT_APPLIED) {
    armCommand.accepted = true;
    return [];
  }
  if (result === RESULT_WRONG_CODE) {
    const events = recordWrongCode(Date.now());
    finishArm("wrong");
    return events;
  }
  finishArm(result === RESULT_NOT_SENT ? "offline" : result > 0 ? "rejected" : "unknown");
  return [];
}

/* Success is only reported once the box's own status shows the new state. */
function confirmArm(reading) {
  if (!armCommand?.accepted || reading.armed !== (armCommand.target === "arm")) return;
  const guard = store.armGuard;
  if (guard.wrong || guard.lockouts) {
    Object.assign(guard, { wrong: 0, lockouts: 0, lockedUntil: 0 });
    store.saveArmGuard();
  }
  finishArm("applied");
}

/* The reply to a reading carries a waiting command, once and never again. */
function collectCommand() {
  if (!armCommand || armCommand.code === null) return null;
  const { id, target, code } = armCommand;
  armCommand.code = null;
  clearTimeout(armCommand.timer);
  armCommand.timer = setTimeout(() => finishArm("unknown"), ARM_CONFIRM_MS);
  return `D ${id} ${target === "arm" ? 1 : 0} ${code}\n`;
}

function handleArmStatus(req, res) {
  sendJson(res, 200, armStatus());
}

async function handleArmAttempt(req, res) {
  /* A cross-site page can't send JSON here without a preflight, which this server refuses. */
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
    sendJson(res, 415, { error: "Send JSON" });
    return;
  }

  let data;
  try {
    data = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, error.status ?? 400, { error: "Body must be JSON" });
    return;
  }
  if (typeof data?.code !== "string" || !ARM_CODE.test(data.code) || !["arm", "disarm"].includes(data.target)) {
    sendJson(res, 400, { error: "Send a four-move code and a target of arm or disarm" });
    return;
  }

  const status = armStatus();
  if (status.lockedForMs > 0) {
    sendJson(res, ARM_STATUS.locked, { outcome: "locked", ...status });
    return;
  }
  if (armCommand) {
    sendJson(res, ARM_STATUS.busy, { outcome: "busy", ...status });
    return;
  }
  if (!boardOnline || store.latest?.armed == null) {
    sendJson(res, ARM_STATUS.offline, { outcome: "offline", ...status });
    return;
  }

  armCommand = {
    id: nextCommandId++,
    target: data.target,
    code: data.code,
    accepted: false,
    res,
    timer: setTimeout(() => finishArm("offline"), ARM_DELIVERY_MS),
  };
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

  const { reading, commandResult, error } = parseReading(body);
  if (error) {
    sendJson(res, 400, { error });
    return;
  }

  const { sample, events } = store.add(reading);
  boardOnline = true;
  if (commandResult) events.push(...applyCommandResult(commandResult));
  confirmArm(reading);
  broadcast("sample", { sample, events, boardOnline });

  const command = collectCommand();
  if (command) send(res, 200, command, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
  else sendJson(res, 204);
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
  "/api/arm": { GET: handleArmStatus, POST: handleArmAttempt },
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
