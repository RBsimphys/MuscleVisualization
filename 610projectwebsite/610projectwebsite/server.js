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
const db = require('./db');

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '2mb' })); // raised from default 100kb - waveform_summary arrays can be a few hundred points
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

// ---------- Session summary database (see db.js) ----------

// Save a completed (or in-progress) session's summary, from live.html or test.html.
app.post('/api/sessions', (req, res) => {
  const p = req.body;
  const required = ['mode', 'baseline', 'mvc', 'low_zone_pct', 'high_zone_pct', 'duration_sec', 'sample_count'];
  const missing = required.filter((key) => p[key] === undefined || p[key] === null);
  if (missing.length > 0) {
    return res.status(400).json({ error: `missing required field(s): ${missing.join(', ')}` });
  }
  try {
    const id = db.insertSession(p);
    res.json({ ok: true, id });
  } catch (err) {
    console.error('Failed to save session:', err);
    res.status(500).json({ error: err.message });
  }
});

// List all saved sessions (summary fields only, no waveform - see /api/sessions/:id for that).
app.get('/api/sessions', (req, res) => {
  try {
    res.json(db.listSessions());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full record for one session, including its downsampled waveform.
app.get('/api/sessions/:id', (req, res) => {
  const session = db.getSession(Number(req.params.id));
  if (!session) return res.status(404).json({ error: 'not found' });
  res.json(session);
});

app.delete('/api/sessions/:id', (req, res) => {
  const deleted = db.deleteSession(Number(req.params.id));
  if (!deleted) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
  console.log('Waiting for the ESP32 to start POSTing to /adc...');
});
