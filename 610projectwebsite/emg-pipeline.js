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
 * Calibration is two numbers collected once per patient:
 *   baseline - the noise-floor RMS level when the muscle is at rest
 *   mvc      - the RMS level during maximum voluntary contraction
 *
 * %MVC = clip(0, 100, (rms - baseline) / (mvc - baseline) * 100)
 */

const EMA_ALPHA = 0.1;      // matches offline script: alpha=0.1, slow/heavy smoothing
const RMS_WINDOW = 50;      // matches offline script: 50-sample sliding RMS window
const ADC_MAX = 4095;       // 12-bit ADC ceiling

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
    this.baseline = null; // RMS level at rest
    this.mvc = null;      // RMS level at max voluntary contraction
    this.lowZonePct = 40;  // green/yellow boundary, matches offline script's 40th percentile
    this.highZonePct = 75; // yellow/red boundary, matches offline script's 75th percentile
  }

  get isBaselineSet() { return this.baseline !== null; }
  get isMvcSet() { return this.mvc !== null; }
  get isCalibrated() { return this.isBaselineSet && this.isMvcSet; }

  /**
   * Reduce a window of RMS samples (collected while patient is resting)
   * to a single baseline value. Median is robust to occasional movement
   * artifacts during the resting recording.
   */
  setBaselineFromSamples(rmsSamples) {
    if (rmsSamples.length === 0) throw new Error('No samples collected for baseline.');
    this.baseline = median(rmsSamples);
    return this.baseline;
  }

  /**
   * Reduce a window of RMS samples (collected during max-effort recording)
   * to a single MVC value. Average of the top 20% favors the sustained peak
   * effort over brief noise spikes or the ramp-up/ramp-down edges.
   */
  setMvcFromSamples(rmsSamples) {
    if (rmsSamples.length === 0) throw new Error('No samples collected for MVC.');
    const sorted = [...rmsSamples].sort((a, b) => a - b);
    const topCount = Math.max(1, Math.round(sorted.length * 0.2));
    const top = sorted.slice(sorted.length - topCount);
    this.mvc = top.reduce((s, v) => s + v, 0) / top.length;
    if (this.mvc <= this.baseline) {
      // Guard against a degenerate calibration (MVC recorded weaker than baseline)
      this.mvc = this.baseline + 1;
    }
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
  }
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
