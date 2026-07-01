/**
 * data-source.js
 *
 * Abstraction over "where samples come from". Both implementations below
 * share the same shape:
 *   new SomeDataSource(onSample)
 *   .start() / .stop()
 * onSample(rawValue) is called once per sample.
 *
 * ESP32PollingDataSource is what app.js uses now - it polls this same
 * server's GET /adc (see server.js), which the ESP32 pushes readings into
 * via POST /adc. SimulatedFileDataSource (unused right now) is kept here in
 * case you need to go back to offline testing with a recorded .txt file.
 */

/** Polls GET /adc on this server and forwards each new value to onSample. */
class ESP32PollingDataSource {
  /**
   * @param {(rawValue: number) => void} onSample
   * @param {{ url?: string, intervalMs?: number, staleMs?: number }} [opts]
   */
  constructor(onSample, opts = {}) {
    this.onSample = onSample;
    this.url = opts.url || '/adc';
    this.intervalMs = opts.intervalMs || 50; // ~20 polls/sec - plenty to feel live without hammering the network
    this.staleMs = opts.staleMs || 1500;     // how long without a new reading before we call it "no signal"

    this.lastValue = null;
    this.lastReceivedAt = 0;     // ms (Date.now()) we last got a *new* reading from the ESP32
    this.lastPolledAt = 0;       // ms we last successfully reached the server at all
    this.lastError = null;

    this._timer = null;
    this._lastSeenUpdateTs = null; // server's lastUpdated value, to detect genuinely new readings
    this._pollInFlight = false;    // guards against overlapping fetches piling up (see _poll)
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._poll(), this.intervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** Ms since the server last reported a genuinely new reading from the ESP32. */
  msSinceLastReading() {
    if (!this.lastReceivedAt) return Infinity;
    return Date.now() - this.lastReceivedAt;
  }

  get isLive() {
    return this.msSinceLastReading() < this.staleMs;
  }

  async _poll() {
    // setInterval fires on a fixed schedule regardless of whether the last
    // fetch finished. If the network or server ever lags even briefly, skip
    // this tick rather than starting a second overlapping request - without
    // this guard, a slow patch causes requests to stack up faster than they
    // resolve, and the backlog only grows from there for the rest of the
    // session (this is almost certainly why things got worse over time
    // during testing, rather than staying at one consistent level of lag).
    if (this._pollInFlight) return;
    this._pollInFlight = true;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, this.intervalMs * 10));

    try {
      const res = await fetch(this.url, { cache: 'no-store', signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.lastPolledAt = Date.now();
      this.lastError = null;

      if (typeof data.value !== 'number') return;
      this.lastValue = data.value;

      // Only treat it as a "new" reading (and feed the pipeline) if the
      // server's lastUpdated timestamp actually advanced - otherwise we'd
      // re-feed the same stale value on every poll tick.
      if (data.lastUpdated && data.lastUpdated !== this._lastSeenUpdateTs) {
        this._lastSeenUpdateTs = data.lastUpdated;
        this.lastReceivedAt = Date.now();
        this.onSample(this.lastValue);
      }
    } catch (err) {
      this.lastError = controller.signal.aborted ? 'request timed out' : err.message;
    } finally {
      clearTimeout(timeout);
      this._pollInFlight = false;
    }
  }
}

class SimulatedFileDataSource {
  /** @param {(rawValue: number, elapsedMs: number) => void} onSample */
  constructor(onSample) {
    this.onSample = onSample;
    this.rows = [];       // [{ t: seconds|null, value: number }]
    this.hasTimestamps = false;
    this._timer = null;
    this._index = 0;
    this._playing = false;
    this.loop = true;
    this.fallbackSampleRateHz = 100; // used only if file has no timestamp column
    this.speedMultiplier = 1;
  }

  /** Parse a .txt file: either "time,value" rows or one raw value per line. */
  async loadFile(file) {
    const text = await file.text();
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

    const rows = [];
    let hasTimestamps = true;

    for (const line of lines) {
      if (line.toLowerCase().startsWith('time')) continue; // skip header row
      if (line.includes(',')) {
        const [a, b] = line.split(',');
        const t = parseFloat(a);
        const value = parseFloat(b);
        if (Number.isNaN(value)) continue;
        rows.push({ t: Number.isNaN(t) ? null : t, value });
        if (Number.isNaN(t)) hasTimestamps = false;
      } else {
        const value = parseFloat(line);
        if (Number.isNaN(value)) continue;
        rows.push({ t: null, value });
        hasTimestamps = false;
      }
    }

    if (rows.length === 0) throw new Error('No numeric samples found in file.');

    this.rows = rows;
    this.hasTimestamps = hasTimestamps;
    this._index = 0;
    return { count: rows.length, hasTimestamps, durationSec: hasTimestamps ? rows[rows.length - 1].t : null };
  }

  start() {
    if (this.rows.length === 0) throw new Error('No file loaded.');
    if (this._playing) return;
    this._playing = true;
    this._scheduleNext();
  }

  pause() {
    this._playing = false;
    if (this._timer) clearTimeout(this._timer);
  }

  restart() {
    this.pause();
    this._index = 0;
  }

  stop() {
    this.pause();
    this._index = 0;
  }

  _scheduleNext() {
    if (!this._playing) return;
    if (this._index >= this.rows.length) {
      if (this.loop) {
        this._index = 0;
      } else {
        this._playing = false;
        return;
      }
    }

    const row = this.rows[this._index];
    const nextRow = this.rows[this._index + 1];

    let delayMs;
    if (this.hasTimestamps && nextRow) {
      delayMs = Math.max(0, (nextRow.t - row.t) * 1000) / this.speedMultiplier;
    } else {
      delayMs = (1000 / this.fallbackSampleRateHz) / this.speedMultiplier;
    }

    this.onSample(row.value, row.t !== null ? row.t * 1000 : this._index * delayMs);
    this._index += 1;

    this._timer = setTimeout(() => this._scheduleNext(), delayMs);
  }
}
