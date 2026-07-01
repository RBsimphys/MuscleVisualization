/**
 * emg-pipeline.js
 *
 * Live port of the offline EMG analysis script (EMA smoothing -> RMS envelope
 * -> baseline/MVC calibration -> %MVC), adapted for sample-by-sample streaming
 * instead of batch processing over a whole recorded file.
 *
 * Pipeline per incoming raw sample:
 *   raw -> EMA smoothing -> sliding-window RMS envelope -> %MVC (once calibrated)
 *
 * Calibration matches the offline script's algorithm as closely as possible,
 * just applied to two short labeled recordings (a rest window and a
 * max-effort window) instead of inferred after the fact from one long
 * unlabeled trace:
 *   baseline = 20th percentile of RMS during the rest recording
 *   rms_adj  = rms - baseline
 *   segments = contiguous runs of rms_adj above 2.5 * median(rms_adj),
 *              >=10 samples long, with gaps <15 samples merged together
 *   MVC      = mean rms_adj of the top 3 segments >=50 samples long
 *              (falls back to averaging all detected segments if fewer
 *              than 3 qualify, or to the top 20% of samples directly if
 *              no segment clears the threshold at all - see note below)
 *   %MVC     = clip(0, 100, (rms - baseline) / MVC * 100)
 *
 * One deliberate deviation: the offline script's LED thresholds (40th/75th
 * percentile of %MVC) are computed from one long trace with natural
 * variation across effort levels. Our two calibration recordings are pure
 * rest / pure max effort by design (that's the point of the new calibration
 * UI), so percentiling their combination doesn't estimate a real "40%
 * effort" level - it just reflects how many rest-samples vs max-samples got
 * recorded. Keeping the 40/75 numbers fixed (matching the script's typical
 * values) instead of recomputing them from data that can't support that
 * computation. Flag if you want this revisited.
 */

const EMA_ALPHA = 0.1;      // matches offline script: alpha=0.1, slow/heavy smoothing
const RMS_WINDOW = 50;      // matches offline script: 50-sample sliding RMS window
const ADC_MAX = 4095;       // 12-bit ADC ceiling

const BASELINE_PERCENTILE = 20;
const SEGMENT_THRESHOLD_MULTIPLIER = 2.5;
const MIN_SEGMENT_LENGTH = 10;   // samples; matches offline script's minimum contraction duration
const SEGMENT_MERGE_GAP = 15;    // samples; merge segments separated by less than this
const LONG_SEGMENT_LENGTH = 50;  // samples; "long" contractions used for MVC estimate
const LOW_ZONE_PERCENTILE = 40;
const HIGH_ZONE_PERCENTILE = 75;

class EMGProcessor {
  constructor() {
    this.emaValue = null;
    this.rmsBuffer = []; // last RMS_WINDOW ema values
  }

  /** Feed one raw ADC sample. Returns { raw, ema, rms }. */
  pushSample(rawValue) {
    const raw = Math.max(0, Math.min(ADC_MAX, rawValue));

    this.emaValue = this.emaValue === null
      ? raw
      : EMA_ALPHA * raw + (1 - EMA_ALPHA) * this.emaValue;

    this.rmsBuffer.push(this.emaValue);
    if (this.rmsBuffer.length > RMS_WINDOW) this.rmsBuffer.shift();

    const meanSq = this.rmsBuffer.reduce((sum, v) => sum + v * v, 0) / this.rmsBuffer.length;
    const rms = Math.sqrt(meanSq);

    return { raw, ema: this.emaValue, rms };
  }

  reset() {
    this.emaValue = null;
    this.rmsBuffer = [];
  }
}

/**
 * Tracks the two calibration recordings (baseline + MVC) and converts
 * live RMS values into %MVC once both are set.
 */
class Calibration {
  constructor() {
    this.baseline = null; // RMS level at rest (20th percentile of resting RMS)
    this.mvc = null;      // RMS level corresponding to 100% MVC (baseline + segment-derived strength)
    this.lowZonePct = LOW_ZONE_PERCENTILE;   // green/yellow boundary
    this.highZonePct = HIGH_ZONE_PERCENTILE; // yellow/red boundary
  }

  get isBaselineSet() { return this.baseline !== null; }
  get isMvcSet() { return this.mvc !== null; }
  get isCalibrated() { return this.isBaselineSet && this.isMvcSet; }

  /**
   * baseline = 20th percentile of the RMS values collected while the
   * patient is at rest. Matches the offline script's noise-floor estimate,
   * just computed from a window we know is pure rest rather than inferred
   * from a mixed trace.
   */
  setBaselineFromSamples(rmsSamples) {
    if (rmsSamples.length === 0) throw new Error('No samples collected for baseline.');
    this.baseline = percentile(rmsSamples, BASELINE_PERCENTILE);
    return this.baseline;
  }

  /**
   * Runs the same adaptive-threshold segment detection as the offline
   * script on the max-effort recording, then averages the strongest
   * segments to get the MVC reference level.
   */
  setMvcFromSamples(rmsSamples) {
    if (rmsSamples.length === 0) throw new Error('No samples collected for MVC.');
    if (this.baseline === null) throw new Error('Set baseline before MVC.');

    const rmsAdj = rmsSamples.map((v) => v - this.baseline);
    const segments = findActiveSegments(rmsAdj);

    let pool;
    const longSegments = segments.filter((s) => s.length >= LONG_SEGMENT_LENGTH);
    if (longSegments.length >= 3) {
      pool = [...longSegments].sort((a, b) => b.mean - a.mean).slice(0, 3);
    } else if (segments.length > 0) {
      // Fewer than 3 long contractions detected - fall back to averaging
      // every segment found, same as the offline script's fallback.
      pool = segments;
    } else {
      // No segment cleared the adaptive threshold at all (can happen on a
      // short or noisy live recording) - fall back to the strongest 20% of
      // samples directly so calibration can still complete.
      const sorted = [...rmsAdj].sort((a, b) => a - b);
      const topCount = Math.max(1, Math.round(sorted.length * 0.2));
      const meanTop = sorted.slice(sorted.length - topCount).reduce((s, v) => s + v, 0) / topCount;
      pool = [{ mean: meanTop }];
    }

    const mvcAdj = pool.reduce((s, seg) => s + seg.mean, 0) / pool.length;
    this.mvc = this.baseline + Math.max(mvcAdj, 1); // guard against a degenerate (near-zero) calibration
    return this.mvc;
  }

  /** Convert a live RMS value to %MVC (0-100), once calibrated. */
  toPercentMVC(rms) {
    if (!this.isCalibrated) return null;
    const pct = ((rms - this.baseline) / (this.mvc - this.baseline)) * 100;
    return Math.max(0, Math.min(100, pct));
  }

  /** Classify a %MVC value into the biofeedback zone. */
  zoneFor(pctMVC) {
    if (pctMVC === null) return 'unknown';
    if (pctMVC >= this.highZonePct) return 'red';
    if (pctMVC >= this.lowZonePct) return 'yellow';
    return 'green';
  }

  reset() {
    this.baseline = null;
    this.mvc = null;
    this.lowZonePct = LOW_ZONE_PERCENTILE;
    this.highZonePct = HIGH_ZONE_PERCENTILE;
  }
}

/**
 * Adaptive-threshold contraction segment detection, matching the offline
 * script: threshold = 2.5 * median(rmsAdj), contiguous runs above it that
 * are at least MIN_SEGMENT_LENGTH samples long count as a segment, and
 * segments separated by a gap smaller than SEGMENT_MERGE_GAP get merged.
 */
function findActiveSegments(rmsAdj) {
  if (rmsAdj.length === 0) return [];
  const threshold = SEGMENT_THRESHOLD_MULTIPLIER * median(rmsAdj);

  const rawRuns = [];
  let start = null;
  for (let i = 0; i < rmsAdj.length; i++) {
    const active = rmsAdj[i] > threshold;
    if (active && start === null) start = i;
    if (!active && start !== null) {
      rawRuns.push([start, i - 1]);
      start = null;
    }
  }
  if (start !== null) rawRuns.push([start, rmsAdj.length - 1]);

  const longEnoughRuns = rawRuns.filter(([s, e]) => (e - s + 1) >= MIN_SEGMENT_LENGTH);
  if (longEnoughRuns.length === 0) return [];

  // Merge runs separated by a small gap.
  const merged = [longEnoughRuns[0].slice()];
  for (let i = 1; i < longEnoughRuns.length; i++) {
    const [s, e] = longEnoughRuns[i];
    const last = merged[merged.length - 1];
    const gap = s - last[1] - 1;
    if (gap < SEGMENT_MERGE_GAP) {
      last[1] = e;
    } else {
      merged.push([s, e]);
    }
  }

  return merged.map(([s, e]) => {
    const slice = rmsAdj.slice(s, e + 1);
    return {
      start: s,
      end: e,
      length: e - s + 1,
      mean: slice.reduce((sum, v) => sum + v, 0) / slice.length,
    };
  });
}

function median(arr) {
  return percentile(arr, 50);
}

/** Linear-interpolation percentile, matching numpy's default method. */
function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}
