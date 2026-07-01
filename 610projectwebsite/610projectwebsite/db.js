/**
 * db.js
 *
 * Tiny SQLite wrapper using Node's built-in `node:sqlite` module (added in
 * Node 22+, no separate npm package or native build step required - this
 * avoids the common "better-sqlite3 fails to compile" problem you can hit
 * on a laptop without Xcode command line tools / build chains installed).
 *
 * Stores a summary of each calibration + monitoring session: the
 * calibration thresholds, MVC, duration, %MVC min/mean/max, time-in-zone
 * breakdown, and a downsampled waveform for plotting later (e.g. in the
 * presentation). Deliberately does NOT store every raw sample - just
 * enough to reconstruct a useful summary chart and the headline numbers.
 *
 * Requires Node 22.5+. Check with `node -v`. If your Node version is older
 * than that, this will throw "Cannot find module 'node:sqlite'" on
 * startup - update Node (see README) rather than working around it.
 */

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, 'sessions.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    mode TEXT NOT NULL,
    patient_label TEXT,
    baseline REAL NOT NULL,
    mvc REAL NOT NULL,
    low_zone_pct REAL NOT NULL,
    high_zone_pct REAL NOT NULL,
    duration_sec REAL NOT NULL,
    sample_count INTEGER NOT NULL,
    pct_min REAL,
    pct_max REAL,
    pct_mean REAL,
    pct_in_green_frac REAL,
    pct_in_yellow_frac REAL,
    pct_in_red_frac REAL,
    waveform_summary TEXT
  )
`);

const insertStmt = db.prepare(`
  INSERT INTO sessions (
    created_at, mode, patient_label, baseline, mvc, low_zone_pct, high_zone_pct,
    duration_sec, sample_count, pct_min, pct_max, pct_mean,
    pct_in_green_frac, pct_in_yellow_frac, pct_in_red_frac, waveform_summary
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )
`);

function insertSession(payload) {
  const result = insertStmt.run(
    new Date().toISOString(),
    payload.mode || 'unknown',
    payload.patient_label || null,
    payload.baseline,
    payload.mvc,
    payload.low_zone_pct,
    payload.high_zone_pct,
    payload.duration_sec,
    payload.sample_count,
    payload.pct_min ?? null,
    payload.pct_max ?? null,
    payload.pct_mean ?? null,
    payload.pct_in_green_frac ?? null,
    payload.pct_in_yellow_frac ?? null,
    payload.pct_in_red_frac ?? null,
    JSON.stringify(payload.waveform_summary || [])
  );
  return Number(result.lastInsertRowid);
}

const listStmt = db.prepare(`
  SELECT id, created_at, mode, patient_label, baseline, mvc, low_zone_pct, high_zone_pct,
         duration_sec, sample_count, pct_min, pct_max, pct_mean,
         pct_in_green_frac, pct_in_yellow_frac, pct_in_red_frac
  FROM sessions
  ORDER BY id DESC
`);

function listSessions() {
  return listStmt.all();
}

const getStmt = db.prepare(`SELECT * FROM sessions WHERE id = ?`);

function getSession(id) {
  const row = getStmt.get(id);
  if (!row) return null;
  return { ...row, waveform_summary: JSON.parse(row.waveform_summary || '[]') };
}

const deleteStmt = db.prepare(`DELETE FROM sessions WHERE id = ?`);
function deleteSession(id) {
  return deleteStmt.run(id).changes > 0;
}

module.exports = { insertSession, listSessions, getSession, deleteSession };
