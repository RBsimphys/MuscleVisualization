/**
 * app.js
 *
 * Orchestrates: data source -> EMG processor -> calibration -> (chart, gauge, arm).
 * The calibration state machine lives here; the modules it talks to
 * (EMGProcessor, Calibration, ArmViewer, the data source) know nothing about
 * the UI or about each other.
 */

const WARMUP_MS = 5000;     // discard first 5s of every calibration recording
const MAX_CHART_POINTS = 300;

const processor = new EMGProcessor();
const calibration = new Calibration();
const armViewer = new ArmViewer(document.getElementById('arm-viewer-container'));

armViewer.loadModel('armmodel.glb').catch((err) => {
  console.error('Failed to load arm model:', err);
  document.getElementById('arm-viewer-container').innerHTML =
    `<div style="padding:16px;font-family:var(--mono);font-size:12.5px;color:#a33;">
       Could not load armmodel.glb: ${err.message}
     </div>`;
});

// ---------- Chart ----------
const chartLabels = [];
const chartValues = [];
let sampleCount = 0;

const chart = new Chart(document.getElementById('emg-chart'), {
  type: 'line',
  data: {
    labels: chartLabels,
    datasets: [
      {
        label: 'signal',
        data: chartValues,
        borderColor: '#1b6e63',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.15,
      },
      {
        label: 'low zone boundary',
        data: [],
        borderColor: '#c98a12',
        borderDash: [4, 4],
        borderWidth: 1,
        pointRadius: 0,
      },
      {
        label: 'high zone boundary',
        data: [],
        borderColor: '#c2453c',
        borderDash: [4, 4],
        borderWidth: 1,
        pointRadius: 0,
      },
    ],
  },
  options: {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { display: false },
      y: { min: 0, suggestedMax: 100 },
    },
    plugins: { legend: { display: true, labels: { boxWidth: 12, font: { size: 11 } } } },
  },
});

function pushChartPoint(value) {
  sampleCount += 1;
  chartLabels.push(sampleCount);
  chartValues.push(value);
  if (chartLabels.length > MAX_CHART_POINTS) {
    chartLabels.shift();
    chartValues.shift();
  }

  if (calibration.isCalibrated) {
    chart.data.datasets[1].data = chartLabels.map(() => calibration.lowZonePct);
    chart.data.datasets[2].data = chartLabels.map(() => calibration.highZonePct);
  }

  chart.update('none');
}

// ---------- Gauge ----------
const pctReadingEl = document.getElementById('pct-reading');
const zoneDotEl = document.getElementById('zone-dot');
const zoneLabelEl = document.getElementById('zone-label');

function updateGauge(pct) {
  const zone = calibration.isCalibrated ? calibration.zoneFor(pct) : 'unknown';
  pctReadingEl.textContent = pct === null ? '\u2014' : `${pct.toFixed(0)}%`;
  pctReadingEl.className = `reading ${zone}`;
  zoneDotEl.className = `zone-dot ${zone}`;
  zoneLabelEl.textContent = calibration.isCalibrated
    ? zone.toUpperCase()
    : 'awaiting calibration';
}

// ---------- Session pill ----------
const sessionPill = document.getElementById('session-pill');
const sessionPillText = document.getElementById('session-pill-text');
function setSessionState(state, text) {
  sessionPill.className = `session-pill ${state}`;
  sessionPillText.textContent = text;
}

// ---------- Calibration state machine ----------
let recordingMode = null;   // null | 'baseline' | 'mvc'
let recordingPhase = null;  // null | 'warmup' | 'collecting'
let recordingStartTs = 0;
let collectedSamples = [];
let warmupTickHandle = null;

const els = {
  baselineStart: document.getElementById('btn-baseline-start'),
  baselineStop: document.getElementById('btn-baseline-stop'),
  baselineStatus: document.getElementById('status-baseline'),
  baselineCountdown: document.getElementById('baseline-countdown'),
  baselineStep: document.getElementById('step-baseline'),
  mvcStart: document.getElementById('btn-mvc-start'),
  mvcStop: document.getElementById('btn-mvc-stop'),
  mvcStatus: document.getElementById('status-mvc'),
  mvcCountdown: document.getElementById('mvc-countdown'),
  mvcStep: document.getElementById('step-mvc'),
  recalibrate: document.getElementById('btn-recalibrate'),
};

function beginRecording(mode) {
  recordingMode = mode;
  recordingPhase = 'warmup';
  recordingStartTs = performance.now();
  collectedSamples = [];

  const step = mode === 'baseline' ? els.baselineStep : els.mvcStep;
  const status = mode === 'baseline' ? els.baselineStatus : els.mvcStatus;
  const startBtn = mode === 'baseline' ? els.baselineStart : els.mvcStart;
  const stopBtn = mode === 'baseline' ? els.baselineStop : els.mvcStop;

  step.classList.add('active');
  startBtn.disabled = true;
  stopBtn.disabled = true; // enabled once warmup ends
  status.textContent = 'warming up';

  if (warmupTickHandle) clearInterval(warmupTickHandle);
  warmupTickHandle = setInterval(() => tickRecording(mode), 100);
}

function tickRecording(mode) {
  const elapsed = performance.now() - recordingStartTs;
  const countdownEl = mode === 'baseline' ? els.baselineCountdown : els.mvcCountdown;
  const status = mode === 'baseline' ? els.baselineStatus : els.mvcStatus;
  const stopBtn = mode === 'baseline' ? els.baselineStop : els.mvcStop;

  if (recordingPhase === 'warmup') {
    const remaining = Math.max(0, WARMUP_MS - elapsed);
    countdownEl.textContent = `discarding warm-up... ${(remaining / 1000).toFixed(1)}s`;
    if (remaining <= 0) {
      recordingPhase = 'collecting';
      stopBtn.disabled = false;
      status.textContent = 'recording';
    }
  } else if (recordingPhase === 'collecting') {
    countdownEl.textContent = `recording... ${((elapsed - WARMUP_MS) / 1000).toFixed(1)}s captured`;
  }
}

function stopRecording() {
  const mode = recordingMode;
  if (!mode) return;
  clearInterval(warmupTickHandle);
  warmupTickHandle = null;

  const step = mode === 'baseline' ? els.baselineStep : els.mvcStep;
  const status = mode === 'baseline' ? els.baselineStatus : els.mvcStatus;
  const startBtn = mode === 'baseline' ? els.baselineStart : els.mvcStart;
  const stopBtn = mode === 'baseline' ? els.baselineStop : els.mvcStop;
  const countdownEl = mode === 'baseline' ? els.baselineCountdown : els.mvcCountdown;

  stopBtn.disabled = true;

  try {
    if (mode === 'baseline') {
      const value = calibration.setBaselineFromSamples(collectedSamples);
      status.textContent = `set (${value.toFixed(0)})`;
      step.classList.remove('active');
      step.classList.add('done');
      countdownEl.textContent = '';
      els.mvcStart.disabled = false;
      els.mvcStatus.textContent = 'ready';
      setSessionState('calibrating', 'baseline set \u2014 now set max contraction');
    } else {
      const value = calibration.setMvcFromSamples(collectedSamples);
      status.textContent = `set (${value.toFixed(0)})`;
      step.classList.remove('active');
      step.classList.add('done');
      countdownEl.textContent = '';
      setSessionState('live', 'calibrated \u2014 live monitoring');
    }
  } catch (err) {
    status.textContent = `error: ${err.message}`;
    startBtn.disabled = false;
  }

  recordingMode = null;
  recordingPhase = null;
}

function recalibrate() {
  if (warmupTickHandle) clearInterval(warmupTickHandle);
  recordingMode = null;
  recordingPhase = null;
  collectedSamples = [];
  calibration.reset();
  processor.reset();

  els.baselineStep.className = 'cal-step';
  els.baselineStart.disabled = false;
  els.baselineStop.disabled = true;
  els.baselineStatus.textContent = 'not started';
  els.baselineCountdown.textContent = '';

  els.mvcStep.className = 'cal-step';
  els.mvcStart.disabled = true;
  els.mvcStop.disabled = true;
  els.mvcStatus.textContent = 'waiting on baseline';
  els.mvcCountdown.textContent = '';

  setSessionState('', 'not calibrated');
  updateGauge(null);
}

els.baselineStart.addEventListener('click', () => beginRecording('baseline'));
els.baselineStop.addEventListener('click', stopRecording);
els.mvcStart.addEventListener('click', () => beginRecording('mvc'));
els.mvcStop.addEventListener('click', stopRecording);
els.recalibrate.addEventListener('click', recalibrate);

// ---------- Sample handling (the heart of the pipeline) ----------
function handleSample(rawValue) {
  const { rms } = processor.pushSample(rawValue);

  if (recordingMode && recordingPhase === 'collecting') {
    collectedSamples.push(rms);
  }

  if (calibration.isCalibrated) {
    const pct = calibration.toPercentMVC(rms);
    updateGauge(pct);
    pushChartPoint(pct);
    armViewer.setFlexion(pct);
  } else {
    // Pre-calibration: show the raw signal scaled to a 0-100-ish range
    // just so the caretaker can see that data is flowing.
    pushChartPoint((rms / 4095) * 100);
  }
}

// ---------- Live data source: polls this server's /adc, which the ESP32 pushes into ----------
const dataSource = new ESP32PollingDataSource((value) => handleSample(value), { url: '/adc' });
dataSource.start();

const signalPill = document.getElementById('signal-pill');
const signalPillText = document.getElementById('signal-pill-text');
setInterval(() => {
  if (dataSource.isLive) {
    signalPill.className = 'session-pill live';
    signalPillText.textContent = `receiving data (${dataSource.lastValue})`;
  } else if (dataSource.lastError) {
    signalPill.className = 'session-pill stale';
    signalPillText.textContent = `server unreachable: ${dataSource.lastError}`;
  } else {
    signalPill.className = 'session-pill stale';
    signalPillText.textContent = 'no signal from ESP32';
  }
}, 250);

// ---------- Debug flex slider (for tuning arm-viewer.js's FLEX_AXIS by eye) ----------
const debugFlexSlider = document.getElementById('debug-flex-slider');
const debugFlexValue = document.getElementById('debug-flex-value');
debugFlexSlider.addEventListener('input', () => {
  const pct = parseFloat(debugFlexSlider.value);
  debugFlexValue.textContent = `${pct.toFixed(0)}%`;
  armViewer.setFlexion(pct);
});

document.getElementById('btn-frame-model').addEventListener('click', () => armViewer.frameModel());

recalibrate(); // initialize UI to a clean starting state
