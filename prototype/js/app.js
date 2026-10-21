/* CYMATICS — app: render loop, sound → plate mapping, interface */
(function () {
  'use strict';

  const { AudioEngine, Plate } = window.Cymatics;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  const engine = new AudioEngine();
  const plate = new Plate();
  const settings = { sensitivity: 1, density: 1, response: 1 };
  const finePointer = matchMedia('(pointer: fine)').matches;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------- canvases
  const stage = $('#stage');
  const sand = $('#sand'), sctx = sand.getContext('2d', { alpha: false });
  const glow = $('#glow'), gctx = glow.getContext('2d', { alpha: false });
  const haze = $('#haze'), hctx = haze.getContext('2d', { alpha: false });
  haze.width = haze.height = plate.N;
  const hazeImg = hctx.createImageData(plate.N, plate.N);
  let W = 0, H = 0, S = 1, rs = 1, img = null, buf = null;
  let perfScale = 1;

  function desiredCount() {
    const area = innerWidth * innerHeight;
    const base = area * (finePointer ? 0.16 : 0.1);
    return Math.round(clamp(base * settings.density * perfScale, 20000, 320000));
  }

  function resize() {
    const cw = innerWidth, ch = innerHeight;
    rs = Math.min(window.devicePixelRatio || 1, 1.5);
    if (cw * ch * rs * rs > 3.2e6) rs = Math.sqrt(3.2e6 / (cw * ch));
    W = Math.max(1, Math.round(cw * rs));
    H = Math.max(1, Math.round(ch * rs));
    sand.width = W;
    sand.height = H;
    img = sctx.createImageData(W, H);
    buf = new Uint32Array(img.data.buffer);
    glow.width = Math.ceil(W / 4);
    glow.height = Math.ceil(H / 4);
    S = Math.max(W, H) * 0.5;
    plate.setViewport(W, H, S);
    const plateCss = Math.max(cw, ch);
    haze.style.width = haze.style.height = plateCss + 'px';
    plate.setCount(desiredCount());
    $('#o-dens').textContent = Math.round(plate.count / 1000) + 'k';
  }

  // ---------------------------------------------------- sound → plate map
  const lamFromHz = (hz) => hz / 22; // plate eigenvalue that resonates at hz
  const drive = { V: 0, kick: 0, res: 0 };
  const smooth = { dom: 0, low: 0, mid: 0, high: 0 };
  const ambient = { lam: 0, next: 0, holdUntil: 0 };
  const AMBIENT_LAMS = [13, 17, 20, 25, 29, 34, 41, 45, 52, 58, 65, 74, 85, 100, 113];

  // follow a frequency in log space so mode choices don't flicker
  function follow(key, hz, dt, rate) {
    if (!(hz > 20)) return smooth[key];
    const cur = smooth[key];
    if (!cur) return (smooth[key] = hz);
    const k = 1 - Math.exp(-dt * rate);
    return (smooth[key] = Math.exp(Math.log(cur) + (Math.log(hz) - Math.log(cur)) * k));
  }

  function driveFromAudio(F, dt) {
    const sens = settings.sensitivity;
    if (F.level > 0.02 && F.dominantHz > 20) {
      const dom = follow('dom', F.dominantHz, dt, engine.source === 'tone' ? 30 : 7);
      const low = follow('low', F.lowHz, dt, 6);
      const mid = follow('mid', F.midHz, dt, 6);
      const high = follow('high', F.highHz, dt, 6);
      plate.clearTargets();
      // the dominant pitch picks the main figure; each band layers its own
      // structure: low → broad simple cells, high → fine intricate lattice
      drive.res = plate.excite(lamFromHz(dom), 1);
      const own = (pk) => clamp(pk * 4 - 0.15, 0, 1); // ignore leakage from the main peak
      plate.excite(lamFromHz(low), F.low * own(F.lowPk) * 0.55);
      plate.excite(lamFromHz(mid), F.mid * own(F.midPk) * 0.4);
      plate.excite(lamFromHz(high), F.high * own(F.highPk) * 0.45);
      // brightness of the sound sets the rings around the bolt
      plate.setRadial(0.12 + 0.35 * F.low, 1.4 + F.centroidN * 9, 2.1 + F.centroidN * 2.2);
    }
    // loudness drives how hard the plate shakes; being on a resonance helps
    const Vt = clamp(F.level * sens, 0, 1.6) * (0.45 + 0.55 * drive.res) + Math.max(0, F.delta) * 2;
    drive.V += (Vt - drive.V) * (1 - Math.exp(-dt * 10));
    drive.kick = Math.max(drive.kick * Math.exp(-dt * 9), F.onset * sens);
    ambient.holdUntil = performance.now() / 1000 + 3;
  }

  function driveAmbient(t, dt) {
    if (t > ambient.next && t > ambient.holdUntil) {
      let lam;
      do lam = AMBIENT_LAMS[(Math.random() * AMBIENT_LAMS.length) | 0];
      while (lam === ambient.lam);
      ambient.lam = lam;
      ambient.next = t + 8 + Math.random() * 6;
      plate.clearTargets();
      drive.res = plate.excite(lam, 1);
      if (Math.random() < 0.45) plate.excite(lam * (1.8 + Math.random() * 0.8), 0.35);
      plate.setRadial(0.2 + Math.random() * 0.25, 2 + Math.random() * 5, 2.3 + Math.random() * 1.5);
      if (ambient.lam) drive.kick = Math.max(drive.kick, 0.3);
    }
    const Vt = reducedMotion ? 0.3 : 0.42 + 0.1 * Math.sin(t * 0.37);
    drive.V += (Vt - drive.V) * (1 - Math.exp(-dt * 1.5));
    drive.kick *= Math.exp(-dt * 6);
  }

  // ------------------------------------------------------- pointer impulses
  const pointers = new Map();
  function toPlate(e) {
    return { x: (e.clientX * rs - W / 2) / S, y: (e.clientY * rs - H / 2) / S };
  }
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    const p = toPlate(e);
    pointers.set(e.pointerId, { x: p.x, y: p.y, r: 0.13, s: 0.06 });
    closeDrawer();
  });
  stage.addEventListener('pointermove', (e) => {
    const im = pointers.get(e.pointerId);
    if (!im) return;
    const p = toPlate(e);
    im.x = p.x;
    im.y = p.y;
  });
  const release = (e) => pointers.delete(e.pointerId);
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);

  // ------------------------------------------------------------ main loop
  let last = performance.now();
  let frameNo = 0, simAvg = 8, perfCheck = 0;
  const impulses = [];

  function frame(now) {
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    const t = now / 1000;

    const F = engine.analyze(dt);
    if (F.active) driveFromAudio(F, dt);
    else driveAmbient(t, dt);
    if (sweep.on) updateSweep(dt);

    impulses.length = 0;
    pointers.forEach((p) => impulses.push(p));

    const t0 = performance.now();
    plate.update(dt, settings.response);
    plate.computeField();
    plate.step(dt, drive.V, drive.kick, impulses, settings.response);
    plate.render(buf, W, H, S);
    sctx.putImageData(img, 0, 0);
    gctx.drawImage(sand, 0, 0, glow.width, glow.height);
    if ((frameNo & 1) === 0) {
      plate.renderHaze(hazeImg);
      hctx.putImageData(hazeImg, 0, 0);
    }
    simAvg = simAvg * 0.95 + (performance.now() - t0) * 0.05;
    adaptQuality(t);

    drawSpectrum(F);
    updateHud(t, F);
    frameNo++;
    requestAnimationFrame(frame);
  }

  // shed grains on slow machines
  function adaptQuality(t) {
    if (t < perfCheck) return;
    perfCheck = t + 2;
    if (frameNo > 240 && simAvg > 18 && plate.count > 50000) {
      perfScale *= 0.88;
      plate.setCount(desiredCount());
      $('#o-dens').textContent = Math.round(plate.count / 1000) + 'k';
    }
  }

  // ---------------------------------------------------------------- HUD
  const hud = {
    src: $('#h-src'), dom: $('#h-dom'), cen: $('#h-cen'), rms: $('#h-rms'), mode: $('#h-mode'),
    low: $('#b-low'), mid: $('#b-mid'), high: $('#b-high'), res: $('#tone-res'),
  };
  const SOURCE_LABEL = { mic: 'microphone', file: 'audio file', tone: 'tone' };
  const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const noteName = (hz) => {
    const m = Math.round(69 + 12 * Math.log2(hz / 440));
    return NOTES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  };
  const fmtHz = (hz) => (hz >= 1000 ? (hz / 1000).toFixed(2) + ' kHz' : hz.toFixed(hz < 100 ? 1 : 0) + ' Hz');
  let hudT = 0;

  function updateHud(t, F) {
    if (t - hudT < 0.1) return;
    hudT = t;
    hud.src.textContent = engine.source ? SOURCE_LABEL[engine.source] : 'idle drive';
    const sounding = F.active && F.level > 0.02 && F.dominantHz > 20;
    hud.dom.textContent = sounding ? `${fmtHz(F.dominantHz)} · ${noteName(F.dominantHz)}` : '—';
    hud.cen.textContent = sounding ? fmtHz(F.centroidHz) : '—';
    hud.rms.textContent = F.active && F.rms > 0.0005 ? (20 * Math.log10(F.rms)).toFixed(1) + ' dB' : '—';
    const m = plate.dominantMode();
    hud.mode.textContent = m ? `(${m.n}, ${m.m})${m.s < 0 ? ' −' : m.s > 0 ? ' +' : ''}` : '—';
    hud.low.style.transform = `scaleX(${F.low.toFixed(3)})`;
    hud.mid.style.transform = `scaleX(${F.mid.toFixed(3)})`;
    hud.high.style.transform = `scaleX(${F.high.toFixed(3)})`;
    hud.res.style.transform = `scaleX(${engine.source === 'tone' ? drive.res.toFixed(3) : 0})`;
  }

  const spec = $('#spectrum'), spx = spec.getContext('2d');
  function drawSpectrum(F) {
    if (!spec.offsetParent || (frameNo & 1)) return;
    const w = spec.width, h = spec.height;
    spx.clearRect(0, 0, w, h);
    spx.strokeStyle = 'rgba(255,255,255,0.14)';
    spx.beginPath();
    spx.moveTo(0, h - 0.5);
    spx.lineTo(w, h - 0.5);
    spx.stroke();
    if (!F.active || !F.mag) return;
    spx.strokeStyle = 'rgba(255,255,255,0.85)';
    spx.lineWidth = 1.5;
    spx.beginPath();
    const n = F.mag.length - 1;
    for (let x = 0; x <= w; x += 2) {
      const hz = 30 * Math.pow(400, x / w);
      const bin = Math.min(n, Math.round(hz / F.binHz));
      const db = 20 * Math.log10(F.mag[bin] + 1e-9);
      const y = h - clamp((db + 100) / 90, 0, 1) * (h - 2) - 1;
      x ? spx.lineTo(x, y) : spx.moveTo(x, y);
    }
    spx.stroke();
  }

  // --------------------------------------------------------------- toasts
  const toastEl = $('#toast');
  let toastTimer = 0;
  function toast(msg, ms = 3800) {
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), ms);
  }

  // ------------------------------------------------------------- sources
  const tabs = $$('.sources [data-tab]');
  let activeTab = 'none';

  function selectTab(name) {
    activeTab = name;
    tabs.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    $$('.panel').forEach((p) => (p.hidden = p.dataset.panel !== name));
  }
  tabs.forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

  function refreshSourceUI() {
    tabs.forEach((b) => b.classList.toggle('live', engine.source === b.dataset.tab && isSounding(b.dataset.tab)));
    $('#tone-toggle').textContent = engine.tone.running ? 'Stop tone' : 'Start tone';
    $('#mic-toggle').textContent = engine.mic.stream ? 'Stop microphone' : 'Enable microphone';
    $('#mic-status').textContent = engine.mic.stream ? 'Listening' : 'Off. Nothing is recorded or sent anywhere.';
    const el = engine.file.el;
    $('#file-play').textContent = el && !el.paused ? 'Pause' : 'Play';
    if (engine.source) $('#hint').classList.add('gone');
  }
  function isSounding(src) {
    if (src === 'tone') return engine.tone.running;
    if (src === 'mic') return !!engine.mic.stream;
    if (src === 'file') return !!(engine.file.el && !engine.file.el.paused);
    return false;
  }

  // microphone
  $('#mic-toggle').addEventListener('click', async () => {
    if (engine.mic.stream) {
      engine.stopMic();
      refreshSourceUI();
      return;
    }
    $('#mic-status').textContent = 'Waiting for permission…';
    try {
      await engine.startMic();
      sweep.on = false;
      syncSweep();
    } catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      toast(denied ? 'Microphone permission was declined.' : 'Microphone unavailable: ' + (err.message || err.name));
    }
    refreshSourceUI();
  });
  const micGain = (v) => 0.5 * Math.pow(32, v / 100);
  $('#mic-gain').addEventListener('input', (e) => {
    const g = micGain(+e.target.value);
    engine.setMicGain(g);
    $('#mic-gain-out').textContent = '×' + g.toFixed(1);
  });

  // file
  const fileInput = $('#file-input');
  const fileSeek = $('#file-seek');
  const fmtTime = (s) => (Number.isFinite(s) ? Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0') : '0:00');

  async function loadFile(file) {
    if (!file) return;
    if (file.type && !file.type.startsWith('audio/') && !file.type.startsWith('video/')) {
      toast('That file does not look like audio.');
      return;
    }
    selectTab('file');
    sweep.on = false;
    syncSweep();
    $('#file-name').textContent = file.name;
    $('#file-play').disabled = false;
    fileSeek.disabled = false;
    try {
      await engine.loadFile(file);
    } catch (err) {
      if (err && err.name !== 'AbortError') toast('Could not play this file: ' + (err.message || err.name));
    }
    bindFileEvents();
    refreshSourceUI();
  }

  let fileBound = false;
  function bindFileEvents() {
    if (fileBound) return;
    fileBound = true;
    const el = engine.file.el;
    el.addEventListener('timeupdate', () => {
      if (!seeking && el.duration) fileSeek.value = String(Math.round((el.currentTime / el.duration) * 1000));
      $('#file-time').textContent = fmtTime(el.currentTime);
    });
    el.addEventListener('loadedmetadata', () => ($('#file-dur').textContent = fmtTime(el.duration)));
    el.addEventListener('play', refreshSourceUI);
    el.addEventListener('pause', refreshSourceUI);
    el.addEventListener('error', () => toast('This browser cannot decode that audio format.'));
  }

  let seeking = false;
  fileSeek.addEventListener('input', () => {
    seeking = true;
    const el = engine.file.el;
    if (el && el.duration) el.currentTime = (+fileSeek.value / 1000) * el.duration;
  });
  fileSeek.addEventListener('change', () => (seeking = false));

  fileInput.addEventListener('change', () => {
    loadFile(fileInput.files[0]);
    fileInput.value = '';
  });
  $('label[for="file-input"]').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  function toggleFile() {
    const el = engine.file.el;
    if (!el || !engine.file.url) return;
    if (el.paused) {
      sweep.on = false;
      syncSweep();
      engine.playFile();
    } else engine.pauseFile();
    refreshSourceUI();
  }
  $('#file-play').addEventListener('click', toggleFile);
  $('#file-vol').addEventListener('input', (e) => engine.setFileVolume(+e.target.value / 100));

  // drag & drop anywhere
  const drop = $('#drop');
  let dragDepth = 0;
  addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    drop.classList.add('on');
  });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) drop.classList.remove('on');
  });
  addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    drop.classList.remove('on');
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  // tone generator
  const toneSlider = $('#tone-freq');
  const F_MIN = 20, F_MAX = 4000;
  const sliderToHz = (v) => F_MIN * Math.pow(F_MAX / F_MIN, v / 1000);
  const hzToSlider = (hz) => (1000 * Math.log(hz / F_MIN)) / Math.log(F_MAX / F_MIN);

  function setToneFreq(hz, fromSlider) {
    hz = clamp(hz, F_MIN, F_MAX);
    engine.setToneFreq(hz);
    if (!fromSlider) toneSlider.value = String(Math.round(hzToSlider(hz)));
    $('#tone-hz').textContent = hz < 1000 ? hz.toFixed(1) : hz.toFixed(0);
    $('#tone-note').textContent = noteName(hz);
  }
  toneSlider.addEventListener('input', () => {
    sweep.on = false;
    syncSweep();
    setToneFreq(sliderToHz(+toneSlider.value), true);
  });
  const semitone = (d) => setToneFreq(engine.tone.freq * Math.pow(2, d / 12));
  $('#tone-down').addEventListener('click', () => semitone(-1));
  $('#tone-up').addEventListener('click', () => semitone(1));

  function toggleTone() {
    if (engine.tone.running) engine.stopTone();
    else {
      try {
        engine.startTone();
      } catch (err) {
        toast(err.message);
      }
    }
    if (!engine.tone.running) {
      sweep.on = false;
      syncSweep();
    }
    refreshSourceUI();
  }
  $('#tone-toggle').addEventListener('click', toggleTone);

  $$('#tone-wave button').forEach((b) =>
    b.addEventListener('click', () => {
      $$('#tone-wave button').forEach((o) => o.setAttribute('aria-checked', String(o === b)));
      engine.setToneType(b.dataset.wave);
    })
  );
  $('#tone-amp').addEventListener('input', (e) => engine.setToneAmp((+e.target.value / 100) * 0.9));
  $('#tone-listen').addEventListener('click', (e) => {
    const on = !engine.tone.monitor;
    engine.setToneMonitor(on);
    e.currentTarget.setAttribute('aria-pressed', String(on));
  });

  const sweep = { on: false, dir: 1 };
  function syncSweep() {
    $('#tone-sweep').setAttribute('aria-pressed', String(sweep.on));
  }
  $('#tone-sweep').addEventListener('click', () => {
    sweep.on = !sweep.on;
    if (sweep.on && !engine.tone.running) toggleTone();
    syncSweep();
  });
  function updateSweep(dt) {
    if (!engine.tone.running) return;
    let f = engine.tone.freq * Math.pow(2, (sweep.dir * dt) / 8); // one octave every 8 s
    if (f > 2400) { f = 2400; sweep.dir = -1; }
    else if (f < 40) { f = 40; sweep.dir = 1; }
    setToneFreq(f);
  }

  // eigenmode presets: frequencies that land exactly on a plate resonance
  const presetBox = $('#tone-presets');
  [[2, 1], [3, 1], [3, 2], [4, 2], [4, 3], [5, 3], [6, 2], [6, 4], [7, 4], [8, 3], [9, 5], [10, 6]].forEach(([n, mm]) => {
    const m = plate.modes.find((md) => md.n === n && md.m === mm);
    if (!m) return;
    const hz = Math.round(m.lam * 22);
    const b = document.createElement('button');
    b.textContent = `${m.n}·${m.m}  ${hz < 1000 ? hz : (hz / 1000).toFixed(2) + 'k'}`;
    b.title = `Mode (${m.n}, ${m.m}) at ${hz} Hz`;
    b.addEventListener('click', () => {
      sweep.on = false;
      syncSweep();
      setToneFreq(hz);
      if (!engine.tone.running) toggleTone();
    });
    presetBox.appendChild(b);
  });

  // ---------------------------------------------------------------- tools
  $('#t-scatter').addEventListener('click', scatter);
  function scatter() {
    plate.scatter();
    drive.kick = Math.max(drive.kick, 0.2);
  }

  const drawer = $('#adjust'), adjustBtn = $('#t-adjust'), dock = $('#dock');
  function placeDrawer() {
    const r = dock.getBoundingClientRect();
    drawer.style.bottom = innerHeight - r.top + 10 + 'px';
  }
  function closeDrawer() {
    drawer.hidden = true;
    adjustBtn.setAttribute('aria-expanded', 'false');
  }
  adjustBtn.addEventListener('click', () => {
    const open = drawer.hidden;
    drawer.hidden = !open;
    adjustBtn.setAttribute('aria-expanded', String(open));
    if (open) placeDrawer();
  });
  $('#a-sens').addEventListener('input', (e) => {
    settings.sensitivity = +e.target.value / 100;
    $('#o-sens').textContent = settings.sensitivity.toFixed(2);
  });
  $('#a-resp').addEventListener('input', (e) => {
    settings.response = +e.target.value / 100;
    $('#o-resp').textContent = settings.response.toFixed(2);
  });
  $('#a-dens').addEventListener('input', (e) => {
    settings.density = +e.target.value / 100;
    perfScale = 1;
    plate.setCount(desiredCount());
    $('#o-dens').textContent = Math.round(plate.count / 1000) + 'k';
  });

  $('#t-shot').addEventListener('click', snapshot);
  function snapshot() {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#000';
    x.fillRect(0, 0, W, H);
    const side = S * 2;
    if ('filter' in x) x.filter = `blur(${22 * rs}px)`;
    x.drawImage(haze, (W - side) / 2, (H - side) / 2, side, side);
    x.filter = 'none';
    x.globalCompositeOperation = 'screen';
    x.drawImage(sand, 0, 0);
    if ('filter' in x) x.filter = `blur(${9 * rs}px)`;
    x.globalAlpha = 0.5;
    x.drawImage(glow, 0, 0, W, H);
    x.globalAlpha = 1;
    x.filter = 'none';
    x.globalCompositeOperation = 'source-over';
    // the bolt
    const r = 8 * rs;
    const g = x.createRadialGradient(W / 2 - r * 0.25, H / 2 - r * 0.35, 0, W / 2, H / 2, r);
    g.addColorStop(0, '#f4f4f4');
    g.addColorStop(0.4, '#9a9a9a');
    g.addColorStop(0.8, '#2a2a2a');
    g.addColorStop(1, '#111');
    x.fillStyle = '#000';
    x.beginPath();
    x.arc(W / 2, H / 2, r + 4 * rs, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = g;
    x.beginPath();
    x.arc(W / 2, H / 2, r, 0, Math.PI * 2);
    x.fill();
    c.toBlob((blob) => {
      if (!blob) return toast('Could not save the image.');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `cymatics-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
  }

  const fullBtn = $('#t-full');
  if (!document.fullscreenEnabled) fullBtn.hidden = true;
  fullBtn.addEventListener('click', toggleFull);
  function toggleFull() {
    if (!document.fullscreenEnabled) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }

  function setUiHidden(on) {
    document.body.classList.toggle('ui-hidden', on);
    if (on) closeDrawer();
    if (!on) $('#show-ui').blur();
  }
  $('#t-hide').addEventListener('click', () => setUiHidden(true));
  $('#show-ui').addEventListener('click', () => setUiHidden(false));

  // fade the interface away when the mouse rests, like a gallery piece
  let idleTimer = 0;
  function wake() {
    document.body.classList.remove('quiet');
    clearTimeout(idleTimer);
    if (!finePointer) return;
    idleTimer = setTimeout(() => {
      if (!drawer.hidden || dock.matches(':hover') || dock.contains(document.activeElement)) return wake();
      document.body.classList.add('quiet');
    }, 4500);
  }
  addEventListener('pointermove', wake, { passive: true });
  addEventListener('keydown', wake);
  wake();

  // keyboard
  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target.tagName;
    const inControl = tag === 'INPUT' || tag === 'TEXTAREA';
    const k = e.key.toLowerCase();
    if (k === 'escape') {
      closeDrawer();
      setUiHidden(false);
      return;
    }
    if (inControl && (k.startsWith('arrow') || k === ' ')) return;
    if (e.target.closest && e.target.closest('button') && (k === ' ' || k === 'enter')) return;
    if (k === ' ') {
      e.preventDefault();
      if (activeTab === 'file') toggleFile();
      else if (activeTab === 'tone' || engine.source === 'tone') toggleTone();
      else if (engine.source === 'file') toggleFile();
    } else if ((k === 'arrowleft' || k === 'arrowright') && (activeTab === 'tone' || engine.source === 'tone')) {
      e.preventDefault();
      sweep.on = false;
      syncSweep();
      semitone((k === 'arrowright' ? 1 : -1) * (e.shiftKey ? 12 : 1));
    } else if (k === 'h') setUiHidden(!document.body.classList.contains('ui-hidden'));
    else if (k === 'f') toggleFull();
    else if (k === 's') snapshot();
    else if (k === 'r') scatter();
  });

  document.addEventListener('visibilitychange', () => {
    last = performance.now();
  });

  // ---------------------------------------------------------------- boot
  addEventListener('resize', () => {
    resize();
    if (!drawer.hidden) placeDrawer();
  });
  resize();
  selectTab('none');
  setToneFreq(220);

  // let the first figure form before the curtain opens
  driveAmbient(performance.now() / 1000, 0.016);
  plate.snap();
  plate.computeField();
  for (let i = 0; i < 140; i++) plate.step(1 / 60, 0.6, 0, [], 1);
  drive.V = 0.4;

  setTimeout(() => $('#hint').classList.add('gone'), 9000);
  requestAnimationFrame(frame);

  // debugging/tuning handle
  window.cymatics = { engine, plate, drive, settings };
})();
