# RelicGuard dashboard

Monitoring dashboard for the card showcase box. It currently runs on **demo data**
generated in the browser. It is not yet connected to the board.

## Run locally

```sh
cd dashboard
npm start            # http://localhost:3000  (PORT env var overrides)
```

There are no dependencies to install. Node 20 or newer is required.

- Demo states: use the picker in the footer, or `?demo=normal|humidity|lid|laser|offline`.
- Secondary views: `#history`, `#thresholds`.

## Deploy on Render

`render.yaml` at the repo root defines a Node web service with `rootDir: dashboard`.
In Render, choose **New → Blueprint** and select this repository. The health check is at `/healthz`.

## Connecting the hardware later

`public/demo-source.js` documents the sample shape the UI expects. It mirrors
`SensorData_t` in the firmware, converted to real units. To go live:

1. Have a bridge (a serial-to-HTTP script or a Wi-Fi module) POST samples to a new
   route in `server.js`.
2. Replace `createDemoSource(...)` at the bottom of `public/app.js` with a source
   that polls or streams those samples and calls `onSample(sample)`.

Notes from the current firmware:

- The photoresistor reports an ADC percentage, not lux. Either calibrate it to lux or
  change the light unit and thresholds in `METRICS` / `DEMO_THRESHOLDS` in `app.js`.
- There is no laser-beam sensor in the firmware yet. Until there is, send
  `laserInterrupted: null`. The dashboard will then show the beam as unknown, with a
  caution alert, and will not report it as intact.
