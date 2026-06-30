# EMG Biofeedback Monitor — care-provider website

## Pages
- `index.html` — landing page. Choose **Live Mode** or **Test Mode**, or jump to **Session History**.
- `live.html` — connects to the real ESP32 + sensor (polls this server's `/adc`, which the board POSTs into).
- `test.html` — same dashboard, but plays back a recorded `.txt` signal log instead of live hardware. Has the file-upload/playback controls (Play/Pause/Restart/Speed/Loop).
- `sessions.html` — browse every saved session summary in the database, click a row to see its full stats and waveform chart.

## Core files
- `app-common.js` — the actual application (calibration state machine, chart, gauge, arm wiring, session-saving). Shared by `live.html` and `test.html` - the only thing that differs between those two pages is which data source they construct and pass to `initApp()`.
- `emg-pipeline.js` — port of the offline Python analysis (EMA → RMS envelope → percentile baseline → adaptive-threshold segment detection → MVC → %MVC). See the comment block at the top of the file for exactly what matches the original script and the one deliberate deviation (fixed 40/75 zone thresholds).
- `data-source.js` — `ESP32PollingDataSource` (live.html) polls `/adc`. `SimulatedFileDataSource` (test.html) plays back an uploaded file.
- `arm-viewer.js` — Three.js scene, loads `armmodel.glb`, rotates the `Forearm` bone based on %MVC.
- `server.js` — Express server: receives the ESP32's POSTs, serves the website, and exposes the session-database API.
- `db.js` — SQLite wrapper (Node's built-in `node:sqlite`, no extra package or native build step needed).
- `replay-log.js` — command-line alternative to test.html's file upload: POSTs a recorded log to `/adc` against a running server. Mostly superseded by test.html now, but still handy for testing live.html's ESP32-facing code path without the board.

Put `armmodel.glb` in this same folder — the page expects it at `./armmodel.glb`.

## Running it

```bash
cd <this folder>
npm install
npm start
```

Open **`http://localhost:3000`** — that's the landing page.

**Node version matters here**: the database uses `node:sqlite`, built into Node but only from **Node 22.5 or newer**. Check with `node -v`. If it's older, update from [nodejs.org](https://nodejs.org) (same process as before - download the LTS installer, open a *new* terminal afterward).

## Using it

1. From the landing page, pick **Live Mode** (real ESP32) or **Test Mode** (recorded file).
2. **Test Mode only**: choose a `.txt` file (e.g. `adc_log.txt` or `adc_log_2.txt`, included in this folder) and click Play.
3. **Set baseline**: click Start, wait past the automatic 5s warm-up discard, click Stop.
4. **Set max contraction**: click Start, wait past the 5s warm-up, click Stop. Live monitoring starts automatically.
5. Once you've got a few seconds (ideally longer, for a meaningful summary) of monitoring, click **Save Session Summary** — optionally label it first (e.g. "Patient A — trial 2") — to write it to the database.
6. View everything you've saved on **Session History**: a sortable-by-time table of every session's baseline/MVC/zone thresholds/duration/mean & peak %MVC, plus a per-session waveform chart on click.
7. **Recalibrate (new patient)** resets the live page for the next person; past saved sessions are untouched.

## The database

A single file, `sessions.db`, created automatically next to `server.js` the first time you run `npm start`. Per session, it stores: baseline, MVC, both zone thresholds (low/high %), session duration, sample count, %MVC min/mean/max, the fraction of time spent in each zone (green/yellow/red), and a downsampled waveform (one point per second of monitoring, capped at 600 points) for the detail chart.

It deliberately does **not** store every raw sample - just enough to reproduce the summary numbers and a representative chart, which keeps the database small and is what you actually want for a presentation (headline numbers + a chart), not a full data dump.

`sessions.db` is gitignored by default, since it's regenerated locally and you probably don't want to commit a binary database file by default. If you specifically want to share a populated database with your team (e.g. so everyone sees the same demo sessions before presenting), you can remove it from `.gitignore` and commit it deliberately - just know that's then a binary file under version control, which doesn't diff or merge nicely.

### API (used internally by the pages, but available directly too)
- `POST /api/sessions` — save a session summary (body shape: see `app-common.js`'s `saveSession()`)
- `GET /api/sessions` — list all sessions (summary fields, no waveform)
- `GET /api/sessions/:id` — one session's full record including its waveform
- `DELETE /api/sessions/:id` — remove a session

## Testing with a recorded log

**Easiest**: use **Test Mode** (`test.html`) directly in the browser - upload a `.txt` file, hit Play.

**Alternative**: `replay-log.js` still works if you want to test `live.html`'s actual ESP32-facing code path (the polling/server side) without the board:
```bash
node replay-log.js adc_log.txt
```
in a second terminal, while `npm start` runs in the first. Then open `live.html` (not `test.html`) to watch it.

### A real-data quirk you'll notice

EMA and the RMS envelope are sample-count-based filters, not time-based - same as the offline script. On real, irregularly-timed hardware data, this means a few dozen samples right after a strong contraction ends can still read as elevated %MVC for a moment even though the muscle's already relaxed. Not a bug, just the filter's nature - worth knowing about so it's not surprising during a demo, and worth keeping in mind for the LED matrix's behavior too.

## Connecting the ESP32

The firmware (`MuscleViz_esp/main/main.c`) pushes each reading as `POST /adc` with body `{"value": N}` to a hardcoded `SERVER_URL`.

1. Find this machine's LAN IP (Mac, on Wi-Fi): `ipconfig getifaddr en0`
2. In `main.c`, set `SERVER_URL` to `http://<that-IP>:3000/adc`
3. Make sure the ESP32's WiFi credentials match a network this machine is also on
4. Flash, then open `live.html` and watch the **signal pill** flip from "no signal from ESP32" to "receiving data (N)"

## Performance note

If the page feels laggy, it's very unlikely to be the arm model itself - it's a small mesh (~2,300 vertices), trivial for any GPU. Two real issues we found and fixed previously:
- the page was polling and redrawing up to 50x/second (now ~20 polls/sec, 10 repaints/sec - every sample still runs through the EMG filter regardless, this only throttles how often the DOM/canvas/WebGL get touched)
- the network polling used a fixed-schedule timer that could let requests overlap and pile up if the network ever lagged even briefly, which compounds the longer a session runs (`live.html`'s `ESP32PollingDataSource` now skips a tick instead of overlapping, with a timeout so one slow request can't jam the queue)

If it's still laggy after this, check the browser's dev tools Performance tab to see what's actually taking time.

## Architecture note for the C-hosted discussion

This Express/Node server matches what the existing ESP32 firmware already expects (it POSTs out to a server). If your group moves to the ESP32 hosting everything itself instead: all the static files (`index.html`, `live.html`, `test.html`, `sessions.html`, `*.js`, `*.css`, `armmodel.glb`) could be served directly from its flash unchanged. The session database and its API, though, would need to keep living somewhere with real storage and SQLite support - realistically that still means a small companion server like this one even in an ESP32-hosted setup, since the microcontroller itself isn't a great place to run a SQL database.
