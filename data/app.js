(function () {
  var canvas = document.getElementById('ecgCanvas');
  if (!canvas || !canvas.getContext) {
    return;
  }

  var ctx = canvas.getContext('2d');
  var overlay = document.getElementById('leadOverlay');
  var statusText = document.getElementById('signalState');
  var dot = document.getElementById('signalDot');
  var hrDisplay = document.getElementById('hrValue');
  var hrBadge = document.getElementById('hrBadge');
  var miniCanvas = document.getElementById('miniEcgCanvas');
  var miniCtx = miniCanvas ? miniCanvas.getContext('2d') : null;
  var miniTraceStatus = document.getElementById('miniTraceStatus');
  var hrStatusEl = document.getElementById('hrStatus');
  var hrStatusDot = document.getElementById('hrStatusDot');
  var hrStatusText = document.getElementById('hrStatusText');
  var hrStatusDesc = document.getElementById('hrStatusDesc');
  var gridCanvas = document.createElement('canvas');
  var gridCtx = gridCanvas.getContext('2d');
  var raf = window.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); };

  var state = {
    sampleRate: 500,
    secondsVisible: 6,
    midline: 2048,
    adcMin: 0,
    adcMax: 4095,
    cursorX: 0,
    prevY: null,
    queue: [],
    dpr: 1,
    leadsOk: false,
    prevLeadsOk: false,
    connected: false,
    lastSeq: 0,
    lastDataAt: 0,
    fetchBusy: false,
    envelope: 150,
    /* R-peak detection for HR display — adaptive threshold */
    lastPeakTime: 0,
    rrIntervals: [],
    aboveThreshold: false,
    displayHR: 0,
    rmsDeviation: 30,       /* running RMS of deviation from midline */
    peakMultiplier: 2.2,    /* peak fires when deviation > rms * this */
    /* Cardiac stats tracking */
    maxHR: 0,
    minHR: 999,
    hrSum: 0,
    hrCount: 0,
    allRR: [],   /* full RR history for SDNN calculation */
    /* Smoothing filter buffer to heavily suppress 50/60Hz mains noise */
    filterBuf: [],
    filterLen: 12,
    /* Client-side dynamic midline tracker */
    clientMidline: 2048,
    clientMidlineInit: false,
    miniBufferSize: 600,
    miniBuffer: []
  };

  /* ── Hospital-grade trace config ── */
  var TRACE_COLOR       = '#33ff66';
  var TRACE_GLOW_COLOR  = 'rgba(51, 255, 102, 0.22)';
  var TRACE_WIDTH       = 1.6;     /* thin clinical trace */
  var GLOW_WIDTH        = 3.0;     /* subtle phosphor bloom */
  var BG_COLOR          = '#0a0f0a';
  var GRID_MINOR_COLOR  = 'rgba(34, 85, 52, 0.22)';
  var GRID_MAJOR_COLOR  = 'rgba(42, 110, 62, 0.38)';
  var ERASE_BAR_WIDTH   = 22;

  function nowMs() {
    if (window.performance && typeof window.performance.now === 'function') {
      return window.performance.now();
    }
    return Date.now();
  }

  function setClass(el, name, enabled) {
    if (!el) return;
    if (el.classList) {
      if (enabled) el.classList.add(name);
      else el.classList.remove(name);
      return;
    }
    var current = ' ' + (el.className || '') + ' ';
    var token = ' ' + name + ' ';
    if (enabled && current.indexOf(token) < 0) {
      el.className = (el.className ? el.className + ' ' : '') + name;
    } else if (!enabled && current.indexOf(token) >= 0) {
      el.className = current.replace(token, ' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }
  }

  function setText(el, value) {
    if (!el) return;
    if (typeof el.textContent !== 'undefined') el.textContent = value;
    else el.innerText = value;
  }

  function resizeCanvas() {
    var bounds = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    state.dpr = Math.max(1, Math.min(dpr, 2));
    canvas.width = Math.max(320, Math.floor(bounds.width * state.dpr));
    canvas.height = Math.max(280, Math.floor(bounds.height * state.dpr));
    gridCanvas.width = canvas.width;
    gridCanvas.height = canvas.height;
    drawGrid();
    ctx.drawImage(gridCanvas, 0, 0);
    state.cursorX = 0;
    state.prevY = null;
  }

  function resizeMiniCanvas() {
    if (!miniCanvas) return;
    var bounds = miniCanvas.getBoundingClientRect();
    var dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    miniCanvas.width = Math.max(200, Math.floor(bounds.width * dpr));
    miniCanvas.height = Math.max(80, Math.floor(bounds.height * dpr));
  }

  function drawGrid() {
    var w = gridCanvas.width;
    var h = gridCanvas.height;
    var x, y;

    gridCtx.clearRect(0, 0, w, h);
    gridCtx.fillStyle = BG_COLOR;
    gridCtx.fillRect(0, 0, w, h);

    var minor = Math.max(12, Math.round(16 * state.dpr));
    var major = minor * 5;

    /* Minor grid — very subtle */
    gridCtx.lineWidth = 0.4;
    gridCtx.strokeStyle = GRID_MINOR_COLOR;
    for (x = 0; x <= w; x += minor) {
      gridCtx.beginPath();
      gridCtx.moveTo(x + 0.5, 0);
      gridCtx.lineTo(x + 0.5, h);
      gridCtx.stroke();
    }
    for (y = 0; y <= h; y += minor) {
      gridCtx.beginPath();
      gridCtx.moveTo(0, y + 0.5);
      gridCtx.lineTo(w, y + 0.5);
      gridCtx.stroke();
    }

    /* Major grid */
    gridCtx.lineWidth = 0.7;
    gridCtx.strokeStyle = GRID_MAJOR_COLOR;
    for (x = 0; x <= w; x += major) {
      gridCtx.beginPath();
      gridCtx.moveTo(x + 0.5, 0);
      gridCtx.lineTo(x + 0.5, h);
      gridCtx.stroke();
    }
    for (y = 0; y <= h; y += major) {
      gridCtx.beginPath();
      gridCtx.moveTo(0, y + 0.5);
      gridCtx.lineTo(w, y + 0.5);
      gridCtx.stroke();
    }

    /* Center baseline — faintest guide */
    var cy = Math.round(h * 0.52) + 0.5;
    gridCtx.strokeStyle = 'rgba(51, 255, 102, 0.06)';
    gridCtx.lineWidth = 0.5;
    gridCtx.beginPath();
    gridCtx.moveTo(0, cy);
    gridCtx.lineTo(w, cy);
    gridCtx.stroke();
  }

  function baselineY() {
    return canvas.height * 0.52;
  }

  function mapSampleToY(sample) {
    var center = baselineY();
    var deviation = sample - state.clientMidline;
    var absDeviation = Math.abs(deviation);
    
    /* Auto-Scaling: if signal is tiny, envelope shrinks to magnify it */
    state.envelope = Math.max(absDeviation, state.envelope * 0.998);
    /* Remove artificial ceiling! Clamp: min 10 units for sensitivity, max 2500 to handle MASSIVE full scale swings without clipping */
    var effectiveEnvelope = Math.max(10, Math.min(2500, state.envelope));
    var gain = (canvas.height * 0.42) / effectiveEnvelope;
    
    var y = center - deviation * gain;
    return Math.max(canvas.height * 0.04, Math.min(canvas.height * 0.96, y));
  }

  function redrawSweepBand(x, width) {
    var safeWidth = Math.max(4, width);
    var startX = Math.max(0, Math.floor(x));
    var sliceWidth = Math.min(canvas.width - startX, Math.ceil(safeWidth));
    if (sliceWidth <= 0) return;
    ctx.drawImage(gridCanvas, startX, 0, sliceWidth, canvas.height, startX, 0, sliceWidth, canvas.height);
  }

  /* ── Gentle moving-average smoothing ──
     AD8232 handles baseline wander in hardware.
     Firmware applies 5-sample MA at 500 Hz.
     This adds light client-side smoothing only. */
  function filterSample(raw) {
    state.filterBuf.push(raw);
    if (state.filterBuf.length > state.filterLen) {
      state.filterBuf.shift();
    }
    var sum = 0;
    for (var i = 0; i < state.filterBuf.length; i++) {
      sum += state.filterBuf[i];
    }
    return sum / state.filterBuf.length;
  }

  /* Adaptive R-peak detection — uses deviation-from-midline rather than
     absolute normalized value, so it works regardless of where the DC
     offset sits on the ADC range. */
  function detectPeak(sample) {
    var now = nowMs();
    var deviation = sample - state.clientMidline;
    var absDeviation = Math.abs(deviation);

    /* Update running RMS of deviation (exponential moving average) */
    state.rmsDeviation = state.rmsDeviation * 0.995 + absDeviation * 0.005;

    /* Adaptive threshold: peak = deviation exceeds N× the running RMS.
       Floor raised to 12 to prevent residual noise spikes from registering as Tachycardia. */
    var threshold = Math.max(12, state.rmsDeviation * state.peakMultiplier);

    if (deviation > threshold) {
      if (!state.aboveThreshold) {
        state.aboveThreshold = true;
        if (state.lastPeakTime > 0) {
          var rr = now - state.lastPeakTime;
          if (rr > 300 && rr < 2000) {
            state.rrIntervals.push(rr);
            if (state.rrIntervals.length > 8) {
              state.rrIntervals.shift();
            }
            var sum = 0;
            for (var i = 0; i < state.rrIntervals.length; i++) {
              sum += state.rrIntervals[i];
            }
            state.displayHR = Math.round(60000 / (sum / state.rrIntervals.length));

            /* Track cardiac statistics with 'ultrathink accuracy' by ignoring 1-beat glitches */
            if (state.displayHR > 30 && state.displayHR < 250) {
              if (state.displayHR > state.maxHR) state.maxHR = state.displayHR;
              if (state.displayHR < state.minHR) state.minHR = state.displayHR;
              state.hrSum += state.displayHR;
              state.hrCount++;
              state.allRR.push(rr);
              /* Cap history to last 120 beats (~2 minutes) */
              if (state.allRR.length > 120) state.allRR.shift();
            }
          }
        }
        state.lastPeakTime = now;
      }
    } else if (deviation < threshold * 0.4) {
      /* Hysteresis: must drop well below threshold before re-triggering */
      state.aboveThreshold = false;
    }
  }

  /* Compute SDNN (standard deviation of NN intervals) for HRV */
  function computeSDNN() {
    var arr = state.allRR;
    if (arr.length < 4) return 0;
    var mean = 0;
    var i;
    for (i = 0; i < arr.length; i++) mean += arr[i];
    mean /= arr.length;
    var variance = 0;
    for (i = 0; i < arr.length; i++) {
      var diff = arr[i] - mean;
      variance += diff * diff;
    }
    return Math.round(Math.sqrt(variance / arr.length));
  }

  function updateHRDisplay() {
    if (!hrDisplay) return;
    var valid = state.displayHR > 30 && state.displayHR < 250 && state.leadsOk;
    var hr = state.displayHR;
    setText(hrDisplay, valid ? hr : '--');

    /* HR color coding: Normal=Green, Low/Warning=Yellow, High/Critical=Red */
    var hrColorClass = '';
    var badgeClass = 'waiting';
    var badgeText = '--';
    if (valid) {
      hrColorClass = 'hr-color-normal';
      badgeClass = 'normal';
      if (hr >= 60 && hr <= 100) {
        badgeText = 'NORMAL';
      } else if (hr < 60) {
        badgeText = 'LOW';
      } else {
        badgeText = 'HIGH';
      }
    }
    if (hrDisplay) {
      hrDisplay.className = 'vital-value' + (hrColorClass ? ' ' + hrColorClass : '');
    }
    if (hrBadge) {
      hrBadge.className = 'hr-badge hr-badge--' + badgeClass;
      setText(hrBadge, badgeText);
    }


    /* ── HR Status classification ── */
    if (!hrStatusEl) return;
    var statusClass = 'waiting';
    var label = 'Awaiting Data';
    var desc = 'Waiting for stable heart rate signal';

    if (valid) {
      statusClass = 'normal';
      if (hr < 60) {
        label = '< 60 BPM';
        desc = '⚠️ Low';
      } else if (hr <= 100) {
        label = '60–100 BPM';
        desc = '✅ Normal';
      } else {
        label = '> 100 BPM';
        desc = '⚠️ High';
      }
    }

    hrStatusEl.className = 'hr-status hr-status--' + statusClass;
    if (hrStatusDot) hrStatusDot.className = 'hr-status__dot hr-status__dot--' + statusClass;
    setText(hrStatusText, label);
    setText(hrStatusDesc, desc);

    /* Update mini trace status */
    if (miniTraceStatus) {
      if (state.leadsOk && state.miniBuffer.length > 10) {
        setText(miniTraceStatus, 'Active');
        setClass(miniTraceStatus, 'active', true);
      } else {
        setText(miniTraceStatus, 'Awaiting Signal');
        setClass(miniTraceStatus, 'active', false);
      }
    }
  }

  function drawSample(sample, signalOk) {
    var xStep = canvas.width / (state.secondsVisible * state.sampleRate);

    /* Track client-side dynamic midline from raw samples */
    if (signalOk) {
      if (!state.clientMidlineInit) {
        state.clientMidline = sample;
        state.clientMidlineInit = true;
      } else {
        state.clientMidline = state.clientMidline * 0.9985 + sample * 0.0015;
      }
    }

    /* Apply low-pass filter to smooth the raw ADC noise */
    var filtered = signalOk ? filterSample(sample) : sample;

    /* Push to mini ECG buffer for cardiac stats waveform */
    if (signalOk) {
      state.miniBuffer.push(filtered);
      if (state.miniBuffer.length > state.miniBufferSize) {
        state.miniBuffer.shift();
      }
    }

    var y = signalOk ? mapSampleToY(filtered) : baselineY();
    var nextX;

    if (signalOk) {
      detectPeak(sample); /* use raw sample for peak detection accuracy */
    }

    if (state.cursorX <= 0 || state.cursorX >= canvas.width) {
      ctx.drawImage(gridCanvas, 0, 0);
      state.cursorX = 0;
      state.prevY = y;
    }

    redrawSweepBand(state.cursorX, Math.max(ERASE_BAR_WIDTH * state.dpr, xStep * 14));
    nextX = state.cursorX + xStep;

    var fromY = state.prevY == null ? y : state.prevY;

    /* Layer 1: ultra-faint phosphor bloom */
    ctx.strokeStyle = TRACE_GLOW_COLOR;
    ctx.lineWidth = GLOW_WIDTH * state.dpr;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(state.cursorX, fromY);
    ctx.lineTo(nextX, y);
    ctx.stroke();

    /* Layer 2: ultra-thin core trace */
    ctx.strokeStyle = TRACE_COLOR;
    ctx.lineWidth = TRACE_WIDTH * state.dpr;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(state.cursorX, fromY);
    ctx.lineTo(nextX, y);
    ctx.stroke();

    state.cursorX = nextX;
    state.prevY = y;
    if (state.cursorX >= canvas.width) {
      state.cursorX = 0;
      state.prevY = null;
    }
  }

  /* ── Mini ECG waveform for Cardiac Statistics panel ── */
  function drawMiniEcg() {
    if (!miniCtx) return;
    var w = miniCanvas.width;
    var h = miniCanvas.height;
    var buf = state.miniBuffer;

    /* Background */
    miniCtx.fillStyle = '#0a0f0a';
    miniCtx.fillRect(0, 0, w, h);

    /* Subtle grid */
    var gs = Math.max(10, Math.round(14 * state.dpr));
    miniCtx.strokeStyle = 'rgba(34, 85, 52, 0.15)';
    miniCtx.lineWidth = 0.3;
    var gx, gy;
    for (gx = 0; gx <= w; gx += gs) {
      miniCtx.beginPath();
      miniCtx.moveTo(gx + 0.5, 0);
      miniCtx.lineTo(gx + 0.5, h);
      miniCtx.stroke();
    }
    for (gy = 0; gy <= h; gy += gs) {
      miniCtx.beginPath();
      miniCtx.moveTo(0, gy + 0.5);
      miniCtx.lineTo(w, gy + 0.5);
      miniCtx.stroke();
    }

    /* Center guide */
    miniCtx.strokeStyle = 'rgba(51, 255, 102, 0.05)';
    miniCtx.lineWidth = 0.5;
    miniCtx.beginPath();
    miniCtx.moveTo(0, h * 0.5);
    miniCtx.lineTo(w, h * 0.5);
    miniCtx.stroke();

    /* Not enough data — flat line */
    if (buf.length < 2) {
      miniCtx.strokeStyle = 'rgba(51, 255, 102, 0.2)';
      miniCtx.lineWidth = 1;
      miniCtx.beginPath();
      miniCtx.moveTo(0, h * 0.5);
      miniCtx.lineTo(w, h * 0.5);
      miniCtx.stroke();
      return;
    }

    /* Calculate envelope from buffer */
    var mid = state.clientMidline;
    var env = 30;
    var i, d, dev, x, y;
    for (i = 0; i < buf.length; i++) {
      d = Math.abs(buf[i] - mid);
      if (d > env) env = d;
    }
    env = Math.max(30, Math.min(300, env * 0.85));
    var gain = (h * 0.38) / env;
    var xStep = w / buf.length;

    /* Glow layer */
    miniCtx.strokeStyle = TRACE_GLOW_COLOR;
    miniCtx.lineWidth = 3;
    miniCtx.lineCap = 'round';
    miniCtx.lineJoin = 'round';
    miniCtx.beginPath();
    for (i = 0; i < buf.length; i++) {
      x = i * xStep;
      dev = buf[i] - mid;
      y = h * 0.5 - dev * gain;
      y = Math.max(h * 0.04, Math.min(h * 0.96, y));
      if (i === 0) miniCtx.moveTo(x, y);
      else miniCtx.lineTo(x, y);
    }
    miniCtx.stroke();

    /* Core trace */
    miniCtx.strokeStyle = TRACE_COLOR;
    miniCtx.lineWidth = 1.5;
    miniCtx.lineCap = 'round';
    miniCtx.lineJoin = 'round';
    miniCtx.beginPath();
    for (i = 0; i < buf.length; i++) {
      x = i * xStep;
      dev = buf[i] - mid;
      y = h * 0.5 - dev * gain;
      y = Math.max(h * 0.04, Math.min(h * 0.96, y));
      if (i === 0) miniCtx.moveTo(x, y);
      else miniCtx.lineTo(x, y);
    }
    miniCtx.stroke();
  }

  function setSignalState(isConnected, leadsOk) {
    var healthy = isConnected && leadsOk;
    state.connected = isConnected;
    state.leadsOk = leadsOk;

    setClass(overlay, 'visible', !healthy);
    setClass(dot, 'warn', !healthy);
    if (healthy) setText(statusText, 'Signal live');
    else if (isConnected) setText(statusText, 'Leads off');
    else setText(statusText, 'Connecting');

    /* Reset processing state on leads-off */
    if (!healthy) {
      state.displayHR = 0;
      state.rrIntervals = [];
      state.filterBuf = [];
      state.miniBuffer = [];
    }

    /* Reset envelope & RMS when transitioning from disconnected → connected
       to prevent stale noise-inflated values from flattening the real trace */
    if (leadsOk && !state.prevLeadsOk) {
      state.envelope = 80;
      state.rmsDeviation = 30;
      state.filterBuf = [];
      state.lastPeakTime = 0;
      state.aboveThreshold = false;
      /* Re-initialize client midline from server on reconnection */
      state.clientMidline = state.midline;
      state.clientMidlineInit = false;
    }
    state.prevLeadsOk = leadsOk;

    updateHRDisplay();
  }

  function parseArray(value) {
    return Object.prototype.toString.call(value) === '[object Array]';
  }

  function pollData() {
    if (state.fetchBusy) return;
    state.fetchBusy = true;

    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/ecg?since=' + state.lastSeq + '&_=' + Date.now(), true);
    xhr.setRequestHeader('Cache-Control', 'no-cache');

    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      state.fetchBusy = false;

      if (xhr.status < 200 || xhr.status >= 300) {
        setSignalState(false, false);
        return;
      }

      var data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (e) {
        setSignalState(false, false);
        return;
      }

      if (!data || !parseArray(data.samples)) {
        setSignalState(false, false);
        return;
      }

      state.sampleRate = data.sampleRate || state.sampleRate;
      state.midline = data.midline || state.midline;
      if (typeof data.adcMin === 'number') state.adcMin = data.adcMin;
      if (typeof data.adcMax === 'number') state.adcMax = data.adcMax;
      state.lastSeq = data.nextSeq || state.lastSeq;
      state.lastDataAt = nowMs();
      setSignalState(true, !!data.leadsOk);

      var i;
      for (i = 0; i < data.samples.length; i++) {
        state.queue.push(data.samples[i]);
      }

      var maxQueue = Math.floor(state.sampleRate * 2.6);
      if (state.queue.length > maxQueue) {
        state.queue.splice(0, state.queue.length - maxQueue);
      }
    };

    xhr.onerror = function () {
      state.fetchBusy = false;
      setSignalState(false, false);
    };

    xhr.send();
  }

  var hrUpdateCounter = 0;

  function animate() {
    var now = nowMs();
    var maxPerFrame = 40;
    var drawn = 0;

    if (state.connected && now - state.lastDataAt > 1500) {
      setSignalState(false, false);
    }

    while (state.queue.length && drawn < maxPerFrame) {
      drawSample(state.queue.shift(), state.leadsOk);
      drawn++;
    }

    if (!state.queue.length && (!state.connected || !state.leadsOk)) {
      drawSample(state.midline, false);
    }

    /* Update HR display ~4 times per second */
    hrUpdateCounter++;
    if (hrUpdateCounter >= 15) {
      hrUpdateCounter = 0;
      updateHRDisplay();
    }

    drawMiniEcg();
    raf(animate);
  }

  function handleResize() { resizeCanvas(); resizeMiniCanvas(); }
  if (window.addEventListener) {
    window.addEventListener('resize', handleResize);
  } else if (window.attachEvent) {
    window.attachEvent('onresize', handleResize);
  }

  resizeCanvas();
  resizeMiniCanvas();
  setSignalState(false, false);
  animate();
  pollData();
  setInterval(pollData, 80);
})();
