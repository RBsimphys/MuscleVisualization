# EMG Biofeedback Monitor — care-provider website

## Files
- `index.html` — the page
- `style.css` — styling
- `emg-pipeline.js` — port of the offline Python analysis (EMA → RMS envelope → baseline/MVC calibration → %MVC)
- `data-source.js` — `ESP32PollingDataSource` polls this server's `GET /adc` (which the ESP32 pushes into via `POST /adc`). `SimulatedFileDataSource` is also still in there, unused, in case you ever need to go back to offline testing with a recorded `.txt` file.
- `arm-viewer.js` — Three.js scene that loads `armmodel.glb` and rotates the `Forearm` bone based on %MVC
- `app.js` — wires it all together: calibration state machine, chart, gauge, live-signal indicator
- `server.js` — small Express server: receives the ESP32's POSTs and serves the website itself
- `package.json` — just the one dependency (Express)

Put `armmodel.glb` in this same folder (alongside `index.html`) — the page expects to find it at `./armmodel.glb`.

## Running it

This now needs the real Express server (not a plain static file server), since it has to receive POSTs from the ESP32:

```bash
cd /Users/egu/610projectwebsite
npm install
npm start
```

Then open `http://localhost:3000` in your browser (note the port changed from 8000 to 3000, to match what the ESP32 firmware already expects).

## Connecting the ESP32

The firmware (`MuscleViz_esp/main/main.c`) pushes each reading as `POST /adc` with body `{"value": N}` to a hardcoded `SERVER_URL`. For it to reach this server:

1. Find this machine's LAN IP (Mac, on Wi-Fi): `ipconfig getifaddr en0`
2. In `main.c`, set `SERVER_URL` to `http://<that-IP>:3000/adc`
3. Make sure the ESP32's WiFi credentials in `main.c` match a network this machine is also on
4. Flash, then watch the terminal running `npm start` — you should see no errors, and the **signal pill** in the top-right of the page should flip from "no signal from ESP32" to "receiving data (N)" once readings start arriving

If the pill stays on "no signal": check the ESP32's serial output for connection errors first, then confirm `SERVER_URL`'s IP/port match this machine exactly (your LAN IP changes if you switch networks, so this is the most common thing to go stale).

## Using it

1. Open the page with the ESP32 powered on and connected — confirm the signal pill shows "receiving data."
2. **Set baseline**: patient relaxed, click Start, wait a few seconds past the automatic 5s warm-up discard, click Stop.
3. **Set max contraction**: patient contracts maximally, click Start, wait past the 5s warm-up, click Stop.
4. Live monitoring starts automatically — gauge, chart, and arm all update from the live signal.
5. **Recalibrate (new patient)** resets everything for the next patient.

The **Debug: manual arm flex** panel at the bottom lets you drive the arm directly (bypassing live data) if you ever need to confirm the 3D model itself is still working independent of the sensor.

## If you need to go back to offline/simulated testing

`SimulatedFileDataSource` in `data-source.js` still has the old file-playback logic. To use it again: swap the `ESP32PollingDataSource` construction near the top of `app.js`'s data-source section for a `SimulatedFileDataSource`, and rebuild a minimal file-input UI (removed from `index.html` when we moved to live hardware) - ask if you need this and I'll add it back.

## Architecture note for the C-hosted discussion

Right now the website's "backend" is this small Express/Node server, matching what the existing ESP32 firmware already expects (it POSTs out to a server). If your group moves to having the ESP32 host everything itself (`esp_http_server`, no separate server at all):

- `index.html`, `style.css`, `*.js`, and `armmodel.glb` can be served directly from the ESP32's flash, unchanged.
- `data-source.js` would point at whatever endpoint the C firmware exposes instead of polling this Express server.
- Nothing else (calibration logic, chart, arm, gauge) needs to change either way.
