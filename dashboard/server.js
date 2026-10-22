/*
 * RelicGuard dashboard server.
 *
 * Serves the static dashboard in ./public and a health check for Render.
 * No dependencies: plain node:http.
 *
 * The dashboard currently runs on demo data generated in the browser
 * (public/demo-source.js). When the board is connected, add an ingestion
 * route here (e.g. POST /api/readings from a serial/Wi-Fi bridge) and a
 * matching source in the browser that polls or streams it.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = resolve(fileURLToPath(new URL("./public", import.meta.url)));

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

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");

  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method not allowed", {
      "Content-Type": "text/plain",
      Allow: "GET, HEAD",
    });
    return;
  }

  if (pathname === "/healthz") {
    send(res, 200, JSON.stringify({ ok: true }), {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    return;
  }

  await serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`RelicGuard dashboard listening on http://localhost:${PORT}`);
});
