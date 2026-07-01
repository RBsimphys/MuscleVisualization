/**
 * app-common.js
 *
 * The actual application: calibration state machine, chart, gauge, arm
 * wiring, and session-summary saving. Shared between live.html and
 * test.html - the only thing that differs between those two pages is which
 * data source feeds it (ESP32PollingDataSource vs SimulatedFileDataSource),
 * which each page constructs itself and passes in via initApp().
 *
 * Call initApp({ dataSource, mode, onSignalStatus }) once the page's DOM is
 * ready. `mode` is just a label ('live' | 'test') saved alongside each
 * session summary so the history page can show where the data came from.
 * `onSignalStatus(source)` is called periodically so each page can render
 * its own signal-status indicator however makes sense for that page.
 */

const WARMUP_MS = 5000;     // discard first 5s of every calibration recording
const MAX_CHART_POINTS = 300;
const UI_REFRESH_MS = 100;  // how often the chart/gauge/arm actually repaint (10fps)
                             // - every sample is still run through the EMG filter
                             // regardless of this value, so calibration math and
                             // accuracy are unaffected; this only throttles how
                             // often we touch the DOM/canvas/WebGL.
const WAVEFORM_SAMPLE_EVERY_MS = 1000; // how often a point gets added to the
                                        // saved session's downsampled waveform
const WAVEFORM_MAX_POINTS = 600;       // ~10 minutes of waveform at 1 point/sec
                                        // before we start dropping the oldest

function initApp({ dataSource, mode, onSignalStatus, autoStart = true }) {
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
        { label: 'signal', data: chartValues, borderColor: '#1b6e63', borderWidth: 1.5, pointRadius: 0, tension: 0.15 },
        { label: 'low zone boundary', data: [], borderColor: '#c98a12', borderDash: [4, 4], borderWidth: 1, pointRadius: 0 },
        { label: 'high zone boundary', data: [], borderColor: '#c2453c', borderDash: [4, 4], borderWidth: 1, pointRadius: 0 },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      scales: { x: { display: false }, y: { min: 0, suggestedMax: 100 } },
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
    zoneLabelEl.textContent = calibration.isCalibrated ? zone.toUpperCase() : 'awaiting calibration';
  }

  // ---------- Session pill (calibration status) ----------
  const sessionPill = document.getElementById('session-pill');
  const sessionPillText = document.getElementById('session-pill-text');
  function setSessionState(state, text) {
    sessionPill.className = `session-pill ${state}`;
    sessionPillText.textContent = text;
  }

  // ---------- Session-summary tracking (for the SQL save) ----------
  // Starts accumulating the moment calibration completes, reset on recalibrate
  // or after a successful save. This is intentionally separate from the
  // chart's rolling 300-point window - the chart is "what does it look like
  // right now," this is "summarize the whole monitoring session so far."
  let sessionStats = null;
  function startSessionStats() {
    sessionStats = {
      startedAt: Date.now(),
      count: 0,
      sum: 0,
      min: Infinity,
      max: -Infinity,
      zoneCounts: { green: 0, yellow: 0, red: 0 },
      waveform: [], // [{ t: secondsSinceStart, pct }]
      lastWaveformPushAt: 0,
    };
  }
  function recordSessionSample(pct) {
    if (!sessionStats || pct === null) return;
    sessionStats.count += 1;
    sessionStats.sum += pct;
    sessionStats.min = Math.min(sessionStats.min, pct);
    sessionStats.max = Math.max(sessionStats.max, pct);
    sessionStats.zoneCounts[calibration.zoneFor(pct)] += 1;

    const now = Date.now();
    if (now - sessionStats.lastWaveformPushAt >= WAVEFORM_SAMPLE_EVERY_MS) {
      sessionStats.lastWaveformPushAt = now;
      sessionStats.waveform.push({
        t: Math.round((now - sessionStats.startedAt) / 100) / 10,
        pct: Math.round(pct * 10) / 10,
      });
      if (sessionStats.waveform.length > WAVEFORM_MAX_POINTS) sessionStats.waveform.shift();
    }
  }

  const saveBtn = document.getElementById('btn-save-session');
  const saveStatusEl = document.getElementById('save-session-status');
  const patientLabelInput = document.getElementById('patient-label-input');

  async function saveSession() {
    if (!calibration.isCalibrated || !sessionStats || sessionStats.count === 0) {
      saveStatusEl.textContent = 'Nothing to save yet \u2014 calibrate and monitor for a few seconds first.';
      return;
    }

    const durationSec = (Date.now() - sessionStats.startedAt) / 1000;
    const total = sessionStats.count;
    const payload = {
      mode,
      patient_label: (patientLabelInput && patientLabelInput.value.trim()) || null,
      baseline: calibration.baseline,
      mvc: calibration.mvc,
      low_zone_pct: calibration.lowZonePct,
      high_zone_pct: calibration.highZonePct,
      duration_sec: durationSec,
      sample_count: total,
      pct_min: sessionStats.min === Infinity ? null : sessionStats.min,
      pct_max: sessionStats.max === -Infinity ? null : sessionStats.max,
      pct_mean: sessionStats.sum / total,
      pct_in_green_frac: sessionStats.zoneCounts.green / total,
      pct_in_yellow_frac: sessionStats.zoneCounts.yellow / total,
      pct_in_red_frac: sessionStats.zoneCounts.red / total,
      waveform_summary: sessionStats.waveform,
    };

    saveBtn.disabled = true;
    saveStatusEl.textContent = 'Saving...';
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      saveStatusEl.textContent = `Saved session #${data.id}. View it on the History page.`;
    } catch (err) {
      saveStatusEl.textContent = `Could not save: ${err.message}`;
    } finally {
      saveBtn.disabled = false;
    }
  }
  if (saveBtn) saveBtn.addEventListener('click', saveSession);

  // ---------- Calibration state machine ----------
  let recordingMode = null;
  let recordingPhase = null;
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

  function beginRecording(recMode) {
    recordingMode = recMode;
    recordingPhase = 'warmup';
    recordingStartTs = performance.now();
    collectedSamples = [];

    const step = recMode === 'baseline' ? els.baselineStep : els.mvcStep;
    const status = recMode === 'baseline' ? els.baselineStatus : els.mvcStatus;
    const stopBtn = recMode === 'baseline' ? els.baselineStop : els.mvcStop;
    const startBtn = recMode === 'baseline' ? els.baselineStart : els.mvcStart;

    step.classList.add('active');
    startBtn.disabled = true;
    stopBtn.disabled = true;
    status.textContent = 'warming up';

    if (warmupTickHandle) clearInterval(warmupTickHandle);
    warmupTickHandle = setInterval(() => tickRecording(recMode), 100);
  }

  function tickRecording(recMode) {
    const elapsed = performance.now() - recordingStartTs;
    const countdownEl = recMode === 'baseline' ? els.baselineCountdown : els.mvcCountdown;
    const status = recMode === 'baseline' ? els.baselineStatus : els.mvcStatus;
    const stopBtn = recMode === 'baseline' ? els.baselineStop : els.mvcStop;

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
    const recMode = recordingMode;
    if (!recMode) return;
    clearInterval(warmupTickHandle);
    warmupTickHandle = null;

    const step = recMode === 'baseline' ? els.baselineStep : els.mvcStep;
    const status = recMode === 'baseline' ? els.baselineStatus : els.mvcStatus;
    const startBtn = recMode === 'baseline' ? els.baselineStart : els.mvcStart;
    const stopBtn = recMode === 'baseline' ? els.baselineStop : els.mvcStop;
    const countdownEl = recMode === 'baseline' ? els.baselineCountdown : els.mvcCountdown;

    stopBtn.disabled = true;

    try {
      if (recMode === 'baseline') {
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
        startSessionStats();
        if (saveStatusEl) saveStatusEl.textContent = '';
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
    sessionStats = null;
    if (saveStatusEl) saveStatusEl.textContent = '';
    if (patientLabelInput) patientLabelInput.value = '';

    chartLabels.length = 0;
    chartValues.length = 0;
    chart.data.datasets[1].data = [];
    chart.data.datasets[2].data = [];
    chart.update('none');
    sampleCount = 0;
    latestPct = null;
    latestRawScaled = 0;

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

  // ---------- Sample handling ----------
  let latestPct = null;
  let latestRawScaled = 0;

  function handleSample(rawValue) {
    const { rms } = processor.pushSample(rawValue);

    if (recordingMode && recordingPhase === 'collecting') {
      collectedSamples.push(rms);
    }

    if (calibration.isCalibrated) {
      latestPct = calibration.toPercentMVC(rms);
      recordSessionSample(latestPct);
    } else {
      latestRawScaled = (rms / 4095) * 100;
    }
  }

  setInterval(() => {
    if (calibration.isCalibrated) {
      updateGauge(latestPct);
      pushChartPoint(latestPct);
      armViewer.setFlexion(latestPct);
    } else {
      pushChartPoint(latestRawScaled);
    }
  }, UI_REFRESH_MS);

  // ---------- Data source (constructed by the page, wired in here) ----------
  dataSource.onSample = handleSample; // SimulatedFileDataSource takes its callback this way too (see data-source.js)
  if (autoStart && typeof dataSource.start === 'function') dataSource.start();

  if (onSignalStatus) {
    setInterval(() => onSignalStatus(dataSource), 250);
  }

  // ---------- Debug flex slider ----------
  const debugFlexSlider = document.getElementById('debug-flex-slider');
  const debugFlexValue = document.getElementById('debug-flex-value');
  if (debugFlexSlider) {
    debugFlexSlider.addEventListener('input', () => {
      const pct = parseFloat(debugFlexSlider.value);
      debugFlexValue.textContent = `${pct.toFixed(0)}%`;
      armViewer.setFlexion(pct);
    });
  }
  const frameBtn = document.getElementById('btn-frame-model');
  if (frameBtn) frameBtn.addEventListener('click', () => armViewer.frameModel());

  recalibrate();

  return { dataSource, calibration, armViewer };
}
