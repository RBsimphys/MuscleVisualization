/**
 * server.js
 *
 * Receives live ADC readings pushed from the ESP32 (POST /adc, matching
 * MuscleViz_esp/main/main.c's existing SERVER_URL contract) and serves the
 * website itself, so the whole thing runs on one port.
 *
 * The ESP32 firmware's hardcoded SERVER_URL needs to point at whatever
 * machine runs this server, on this same port - e.g.
 * "http://<this-machine's-LAN-IP>:3000/adc". Find your LAN IP with
 * `ipconfig getifaddr en0` (Mac, Wi-Fi) and make sure the ESP32 and this
 * machine are on the same network.
 */

const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(__dirname)); // serves index.html, *.js, *.css, armmodel.glb

let latestValue = 0;
let lastUpdated = 0; // ms since epoch of the last POST actually received

// ESP32 -> here
app.post('/adc', (req, res) => {
  const value = req.body.value;
  if (typeof value !== 'number') {
    return res.status(400).json({ error: 'expected { value: number }' });
  }
  latestValue = value;
  lastUpdated = Date.now();
  res.json({ ok: true });
});

// Browser -> here (polled by data-source.js)
app.get('/adc', (req, res) => {
  res.json({ value: latestValue, lastUpdated });
});

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
  console.log('Waiting for the ESP32 to start POSTing to /adc...');
});
