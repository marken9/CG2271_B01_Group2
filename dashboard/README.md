# RelicGuard dashboard

Monitoring dashboard for the card showcase box. The ESP32 posts readings to this
server, which streams them to the page and keeps six hours of history plus the
lid/laser event log in Postgres (Supabase).

## Run locally

```sh
cd dashboard
npm install
INGEST_TOKEN=dev-token npm start      # http://localhost:3000  (PORT overrides)
```

Without `DATABASE_URL`, readings are kept in memory only. Send a test reading:

```sh
curl -X POST http://localhost:3000/api/readings \
  -H "Authorization: Bearer dev-token" -H "Content-Type: application/json" \
  -d '{"temperature":21.4,"humidity":47.2,"light":38,"lidOpen":false,"laserInterrupted":null}'
```

- Demo data: pick a demo state in the footer, or open `?demo=normal|humidity|lid|laser|offline`.
- Secondary views: `#history`, `#thresholds`.

## Deploy (Render + Supabase)

1. **Database.** Create a free Supabase project. Under **Connect**, copy the
   **Session pooler** connection string (Render can't reach the IPv6-only direct
   connection) and put the database password in it. The server creates its tables
   in a `relicguard` schema on first start.
2. **Token.** Generate a secret for the ESP32: `openssl rand -hex 32`.
3. **Render.** Push this branch, then **New → Blueprint** and pick the repo.
   `render.yaml` asks for `INGEST_TOKEN` and `DATABASE_URL`. For a service you
   created by hand instead, add both under **Environment**.
   Optional: paste Supabase's SSL certificate (Database settings → SSL) into
   `DATABASE_CA` so the database certificate is verified too.
4. **Keep it awake.** Free services sleep after 15 minutes without requests. The
   ESP32's posts keep it awake while the box is online. For the rest of the time,
   add a free monitor (cron-job.org or UptimeRobot) that requests
   `https://<your-service>.onrender.com/healthz` every 10 minutes. Running 24/7
   uses about 744 of the workspace's 750 free hours a month, so keep other free
   services out of that workspace.
5. **ESP32.** Open `esp32/relicguard_uplink/relicguard_uplink.ino`, fill in the
   Wi-Fi details, your Render URL and the token, and flash it.

## API

| Route | |
|---|---|
| `POST /api/readings` | One reading, `Authorization: Bearer <INGEST_TOKEN>`. JSON fields `temperature` (°C), `humidity` (% RH), `light`, `lidOpen`, `laserInterrupted`; each may be `null` for "no valid reading". Returns 204. |
| `GET /api/stream` | Server-Sent Events: a `snapshot`, then `sample`, `status` and `history` messages. |
| `GET /healthz` | `{ "ok": true }` |

The board counts as offline after 30 seconds without a reading. Send a reading
every 2 seconds; the page marks data stale after 10.

## Notes from the current firmware

- The photoresistor reports an ADC percentage, not lux. Either calibrate it to lux or
  change the light unit and thresholds in `METRICS` / `DEMO_THRESHOLDS` in `public/app.js`.
- There is no laser-beam sensor in the firmware yet, so the ESP32 sends
  `laserInterrupted: null` and the dashboard shows the beam as unknown, not intact.
- The MCXC doesn't send anything to the ESP32 yet. The sketch's header comment
  proposes a one-line format and the `PRINTF` that would produce it.
