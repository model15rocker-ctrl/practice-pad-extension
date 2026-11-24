// 카피 연습 패드 for YouTube — content script (works on www.youtube.com and m.youtube.com)
// Controls the page's own <video>: A-B loop, pitch-preserving speed, step-up speed trainer, count-in.
(() => {
  if (window.__practicePadLoaded) return;
  window.__practicePadLoaded = true;

  // ---------- storage (extension storage when available, else page localStorage) ----------
  const hasExt = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  const store = {
    async get(k, d) {
      try { if (hasExt) { const r = await chrome.storage.local.get(k); return r[k] === undefined ? d : r[k]; } } catch (e) {}
      try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set(k, v) {
      try { if (hasExt) { chrome.storage.local.set({ [k]: v }); return; } } catch (e) {}
      try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
    }
  };

  // ---------- state ----------
  const cfg = { gap: 0, ci: true, trStart: 60, trTarget: 100, trStep: 5, trEvery: 3, open: true };
  const st = { id: null, A: null, B: null, loopOn: true, rate: 100, loops: 0 };
  const tr = { on: false, done: 0, reached: false };
  let video = null, inGap = false, gapLeft = 0, gapTimers = [], lastLoop = 0, rateGuard = 0;

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  // YouTube enforces Trusted Types, so plain innerHTML strings are rejected there.
  let ttPolicy = null;
  try { if (window.trustedTypes && trustedTypes.createPolicy) ttPolicy = trustedTypes.createPolicy('practicePad', { createHTML: x => x }); } catch (e) {}
  const html = x => (ttPolicy ? ttPolicy.createHTML(x) : x);
  function fmt(t, d = 1) {
    if (t == null || !isFinite(t)) return '—';
    const f = Math.pow(10, d), r = Math.round(t * f) / f, m = Math.floor(r / 60), s = (r - m * 60).toFixed(d);
    return m + ':' + (parseFloat(s) < 10 ? '0' : '') + s;
  }
  function videoIdFromUrl() {
    const u = new URL(location.href);
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/(shorts|live)\/([\w-]{11})/);
    return m ? m[2] : null;
  }
  function findVideo() {
    return document.querySelector('#movie_player video.html5-main-video') ||
      document.querySelector('video.html5-main-video') ||
      document.querySelector('#player-container-id video') ||
      document.querySelector('video');
  }
  function adShowing() {
    return !!document.querySelector('.ad-showing, .ad-interrupting');
  }

  // ---------- sound (count-in) ----------
  let actx = null;
  function unlock() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    if (actx && actx.state === 'suspended') actx.resume().catch(() => {});
  }
  function beep(hi) {
    if (!actx || !cfg.ci) return;
    try {
      const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
      o.frequency.value = hi ? 1568 : 1046;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
      o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + 0.12);
    } catch (e) {}
  }

  // ---------- UI (shadow DOM so YouTube styles don't leak in) ----------
  const host = document.createElement('div');
  host.id = 'practice-pad-host';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;left:0;right:0;bottom:0;pointer-events:none;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = html(`
<style>
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif;-webkit-tap-highlight-color:transparent}
button{font:inherit;color:inherit;cursor:pointer;border:0;touch-action:manipulation}
.wrap{pointer-events:auto;margin:0 auto;max-width:560px;background:#0f1114f2;color:#eceff2;border:1px solid #2a2f37;border-bottom:0;border-radius:16px 16px 0 0;box-shadow:0 -6px 24px #0008;padding:8px 8px calc(8px + env(safe-area-inset-bottom))}
.desk .wrap{position:fixed;right:16px;bottom:16px;width:400px;border-radius:16px;border-bottom:1px solid #2a2f37}
.top{display:flex;align-items:center;gap:8px;font-size:13px}
.ttl{font-weight:800;color:#f5a524;white-space:nowrap}
.info{flex:1;color:#8d95a1;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ib{background:#232830;border-radius:8px;padding:6px 10px;font-size:13px}
.body{margin-top:8px;display:grid;gap:6px}
.row{display:grid;gap:6px}
.r5{grid-template-columns:1fr 1fr 1.3fr 1fr 1fr}
.r2{grid-template-columns:1fr 1fr}
.r3{grid-template-columns:1fr 1fr 1fr}
.sb{background:#232830;border-radius:10px;padding:9px 0;font-size:14px;font-weight:700}
.rate{display:flex;align-items:center;justify-content:center;color:#f5a524;font-weight:800;font-size:18px;font-variant-numeric:tabular-nums}
.pb{border-radius:14px;background:#232830;font-size:24px;font-weight:800;height:clamp(64px,11vh,96px);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;user-select:none}
.pb small{font-size:12px;font-weight:600;color:#8d95a1;font-variant-numeric:tabular-nums}
.pb:active,.sb:active,.ib:active{filter:brightness(1.4)}
.play{background:#123b2a;color:#2fcf8a}.play.on{background:#2a3038;color:#eceff2}
.play .big{font-size:34px;color:#f5a524;line-height:1}
.ab{background:#2d2410;color:#f5a524}
.loop.on{background:#3a2c0c;color:#f5a524}
.set{background:#191c21;border:1px solid #2a2f37;border-radius:12px;padding:8px;display:grid;gap:8px;font-size:13px}
.set label{display:flex;align-items:center;gap:6px;color:#8d95a1}
.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.g4 label{flex-direction:column;align-items:stretch;gap:2px;font-size:11px}
.g4 input{width:100%;background:#232830;border:1px solid #2a2f37;border-radius:8px;color:#eceff2;padding:6px 4px;text-align:center;font-size:15px}
.seg{display:grid;grid-template-columns:repeat(5,1fr);gap:4px}
.seg button{background:#232830;border-radius:8px;padding:6px 0;font-size:12px}
.seg button.on{background:#f5a524;color:#1a1200;font-weight:800}
.nud{display:grid;grid-template-columns:auto 1fr 1fr 1fr 1fr;gap:4px;align-items:center}
.nud button{background:#232830;border-radius:8px;padding:6px 0;font-size:12px}
.stat{color:#eceff2;line-height:1.5}.stat b{color:#f5a524}
.sw{width:42px;height:24px;border-radius:24px;background:#2a2f37;position:relative;flex:none}
.sw.on{background:#f5a524}.sw::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.15s}
.sw.on::after{left:21px}
.fab{pointer-events:auto;position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));background:#f5a524;color:#1a1200;font-weight:800;border-radius:999px;padding:10px 14px;box-shadow:0 4px 16px #0008;font-size:14px}
.toast{position:fixed;left:50%;bottom:calc(var(--h,300px) + 10px);transform:translateX(-50%);background:#eceff2;color:#111;font-weight:700;font-size:13px;padding:7px 14px;border-radius:999px;opacity:0;transition:.2s;pointer-events:none;white-space:nowrap}
.toast.show{opacity:1}
[hidden]{display:none!important}
</style>
<div class="toast" id="toast"></div>
<button class="fab" id="fab" hidden>🎸 연습</button>
<div class="wrap" id="wrap">
  <div class="top">
    <span class="ttl">🎸 연습 패드</span>
    <span class="info" id="info"></span>
    <button class="ib" id="gear">⚙</button>
    <button class="ib" id="min">▾</button>
  </div>
  <div class="body">
    <div class="set" id="set" hidden>
      <div style="display:flex;align-items:center;justify-content:space-between"><b>단계별 속도 올리기</b><button class="sw" id="trOn"></button></div>
      <div class="g4">
        <label>시작 %<input type="number" id="trStart" min="25" max="200"></label>
        <label>목표 %<input type="number" id="trTarget" min="25" max="200"></label>
        <label>올림 %<input type="number" id="trStep" min="1" max="25"></label>
        <label>몇 번마다<input type="number" id="trEvery" min="1" max="20"></label>
      </div>
      <div class="stat" id="trStat"></div>
      <div><b>반복 사이 쉬기 · 카운트인</b></div>
      <div class="seg" id="gapSeg"><button data-g="0">없음</button><button data-g="1">1초</button><button data-g="2">2초</button><button data-g="3">3초</button><button data-g="4">4초</button></div>
      <label><input type="checkbox" id="ci"> 쉬는 동안 삑 소리</label>
      <div class="nud"><span>A</span><button data-w="A" data-d="-0.5">−0.5</button><button data-w="A" data-d="-0.05">−0.05</button><button data-w="A" data-d="0.05">+0.05</button><button data-w="A" data-d="0.5">+0.5</button></div>
      <div class="nud"><span>B</span><button data-w="B" data-d="-0.5">−0.5</button><button data-w="B" data-d="-0.05">−0.05</button><button data-w="B" data-d="0.05">+0.05</button><button data-w="B" data-d="0.5">+0.5</button></div>
      <div style="color:#8d95a1;font-size:12px;line-height:1.5">페달/키보드: ← PageUp 구간 처음 · → PageDown 재생/정지 · [ ] A/B 지점 · ↑ ↓ 속도</div>
    </div>
    <div class="row r5">
      <button class="sb" data-r="-5">−5</button><button class="sb" data-r="-1">−1</button>
      <div class="rate" id="rate">100%</div>
      <button class="sb" data-r="1">+1</button><button class="sb" data-r="5">+5</button>
    </div>
    <div class="row r3">
      <button class="sb loop on" id="loop">반복 ON</button>
      <button class="sb" id="clear">구간 지우기</button>
      <button class="sb" id="r100">100%로</button>
    </div>
    <div class="row r2">
      <button class="pb" id="back">⟲<small>구간 처음</small></button>
      <button class="pb play" id="play">▶<small>재생</small></button>
    </div>
    <div class="row r2">
      <button class="pb ab" id="bA">A<small id="aT">시작점</small></button>
      <button class="pb ab" id="bB">B<small id="bT">끝점</small></button>
    </div>
  </div>
</div>`);
  const $ = s => root.querySelector(s), $$ = s => [...root.querySelectorAll(s)];
  // Desktop: floating card at bottom-right. Mobile: bottom sheet.
  const isDesk = !location.hostname.startsWith('m.');
  if (isDesk) { const wrapEl = $('#wrap'), d = document.createElement('div'); d.className = 'desk'; root.insertBefore(d, wrapEl); d.appendChild(wrapEl); }

  let toastT;
  function toast(m) {
    const t = $('#toast'); t.textContent = m; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1400);
  }

  // ---------- playback control ----------
  const loopActive = () => st.loopOn && st.A != null && st.B != null && st.B > st.A;
  function applyRate() {
    if (!video) return;
    rateGuard = performance.now();
    video.preservesPitch = true; video.mozPreservesPitch = true; video.webkitPreservesPitch = true;
    video.playbackRate = st.rate / 100;
  }
  function setRate(p, quiet) {
    st.rate = clamp(Math.round(p), 25, 200);
    applyRate(); save();
    if (!quiet) ui();
  }
  function seek(t) { if (video) { const d = video.duration; try { video.currentTime = clamp(t, 0, isFinite(d) && d > 0 ? d : t); } catch (e) {} } }
  function play() { if (video) { const p = video.play(); if (p && p.catch) p.catch(() => {}); } }
  function pause() { if (video) video.pause(); }
  function clearGap() { gapTimers.forEach(clearTimeout); gapTimers = []; inGap = false; }
  function startGap() {
    const n = cfg.gap; inGap = true;
    for (let i = 0; i < n; i++) gapTimers.push(setTimeout(() => { gapLeft = n - i; beep(i === n - 1); ui(); }, i * 1000));
    gapTimers.push(setTimeout(() => { inGap = false; gapTimers = []; lastLoop = performance.now(); play(); ui(); }, n * 1000));
  }
  function goA(autoplay) {
    if (!video) return; unlock(); clearGap();
    lastLoop = performance.now();
    seek(st.A != null ? st.A : 0);
    if (autoplay && cfg.gap > 0) { pause(); gapLeft = cfg.gap; startGap(); }
    else if (autoplay) play();
    ui();
  }
  function togglePlay() {
    if (!video) return; unlock();
    if (inGap) { clearGap(); pause(); ui(); return; }
    if (video.paused) {
      if (loopActive() && (video.currentTime >= st.B || video.currentTime < st.A - 0.01)) { seek(st.A); lastLoop = performance.now(); }
      play();
    } else pause();
    ui();
  }
  function loopEnd() {
    lastLoop = performance.now();
    st.loops++;
    if (tr.on) {
      tr.done++;
      if (tr.done >= cfg.trEvery) {
        tr.done = 0;
        if (st.rate < cfg.trTarget) {
          setRate(Math.min(cfg.trTarget, st.rate + cfg.trStep), true);
          if (st.rate >= cfg.trTarget) { tr.reached = true; toast('목표 ' + st.rate + '% 도달! 🎉'); }
          else toast('속도 ' + st.rate + '% ↑');
        }
      }
    }
    goA(true);
  }
  function setA() {
    if (!video) return;
    const t = video.currentTime; st.A = t;
    if (st.B != null && st.B <= t + 0.05) st.B = null;
    st.loops = 0; tr.done = 0; save(); ui(); toast('A 지점 ' + fmt(t));
  }
  function setB() {
    if (!video) return;
    const t = video.currentTime;
    if (st.A == null) st.A = 0;
    if (t <= st.A + 0.05) { toast('B는 A보다 뒤에 찍어 주세요'); return; }
    st.B = t; st.loops = 0; tr.done = 0; save();
    if (st.loopOn) { toast('이 구간 반복 시작'); if (!video.paused) goA(true); else ui(); }
    else { toast('B 지점 ' + fmt(t)); ui(); }
  }
  function toggleLoop() { st.loopOn = !st.loopOn; save(); ui(); toast(st.loopOn ? '구간 반복 켜짐' : '구간 반복 꺼짐'); }

  // ---------- persistence ----------
  function save() {
    if (st.id) store.set('pp:v:' + st.id, { A: st.A, B: st.B, rate: st.rate, loopOn: st.loopOn });
  }
  function saveCfg() { store.set('pp:cfg', cfg); }
  async function loadVideoState(id) {
    clearGap();
    st.id = id; st.A = st.B = null; st.loops = 0; st.rate = 100; st.loopOn = true; tr.done = 0; tr.reached = false;
    const d = await store.get('pp:v:' + id, null);
    if (d && st.id === id) { st.A = d.A ?? null; st.B = d.B ?? null; st.rate = d.rate || 100; st.loopOn = d.loopOn !== false; }
    if (tr.on) st.rate = cfg.trStart;
    applyRate(); ui();
  }

  // ---------- wiring ----------
  $$('[data-r]').forEach(b => b.addEventListener('click', () => setRate(st.rate + parseInt(b.dataset.r, 10))));
  $('#r100').addEventListener('click', () => setRate(100));
  $('#loop').addEventListener('click', toggleLoop);
  $('#clear').addEventListener('click', () => { st.A = st.B = null; st.loops = 0; save(); ui(); toast('구간을 지웠어요'); });
  $('#back').addEventListener('click', () => goA(true));
  $('#play').addEventListener('click', togglePlay);
  $('#bA').addEventListener('click', setA);
  $('#bB').addEventListener('click', setB);
  $('#gear').addEventListener('click', () => { $('#set').hidden = !$('#set').hidden; });
  $('#min').addEventListener('click', () => { cfg.open = false; saveCfg(); ui(); });
  $('#fab').addEventListener('click', () => { cfg.open = true; saveCfg(); ui(); });
  $('#trOn').addEventListener('click', () => {
    tr.on = !tr.on; tr.done = 0; tr.reached = false;
    if (tr.on) {
      if (cfg.trTarget < cfg.trStart) cfg.trTarget = cfg.trStart;
      setRate(cfg.trStart, true);
      toast(loopActive() ? cfg.trStart + '%부터 시작' : 'A·B 구간을 정하면 반복마다 속도가 올라가요');
    }
    ui();
  });
  const trFields = { trStart: [25, 200], trTarget: [25, 200], trStep: [1, 25], trEvery: [1, 20] };
  for (const [id, [lo, hi]] of Object.entries(trFields)) {
    const el = $('#' + id);
    el.addEventListener('change', () => {
      let x = parseInt(el.value, 10); if (!isFinite(x)) x = cfg[id];
      cfg[id] = clamp(x, lo, hi); el.value = cfg[id]; saveCfg(); ui();
    });
    el.addEventListener('keydown', e => e.stopPropagation());
  }
  $$('#gapSeg button').forEach(b => b.addEventListener('click', () => { cfg.gap = +b.dataset.g; saveCfg(); ui(); }));
  $('#ci').addEventListener('change', e => { cfg.ci = e.target.checked; saveCfg(); });
  $$('.nud button').forEach(b => b.addEventListener('click', () => {
    const w = b.dataset.w, d = parseFloat(b.dataset.d);
    if (st[w] == null) { toast(w + ' 지점을 먼저 정하세요'); return; }
    const dur = (video && video.duration) || 1e9;
    if (w === 'A') st.A = clamp(st.A + d, 0, st.B != null ? st.B - 0.05 : dur);
    else st.B = clamp(st.B + d, (st.A ?? 0) + 0.05, dur);
    save(); ui();
  }));
  // Keep our clicks from reaching YouTube's own handlers.
  ['click', 'mousedown', 'pointerdown', 'touchstart', 'keydown', 'keyup'].forEach(ev =>
    host.addEventListener(ev, e => e.stopPropagation()));

  // Pedal / keyboard (capture phase so YouTube doesn't also seek ±5s)
  const ourKeys = { ArrowLeft: 1, PageUp: 1, ArrowRight: 1, PageDown: 1, '[': 1, ']': 1, ArrowUp: 1, ArrowDown: 1 };
  window.addEventListener('keydown', e => {
    if (!cfg.open || !st.id || !ourKeys[e.key]) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.repeat && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    switch (e.key) {
      case 'ArrowLeft': case 'PageUp': goA(true); break;
      case 'ArrowRight': case 'PageDown': togglePlay(); break;
      case '[': setA(); break;
      case ']': setB(); break;
      case 'ArrowUp': setRate(st.rate + 5); toast('속도 ' + st.rate + '%'); break;
      case 'ArrowDown': setRate(st.rate - 5); toast('속도 ' + st.rate + '%'); break;
    }
  }, true);

  // ---------- render ----------
  function ui() {
    const onWatch = !!st.id;
    host.style.display = onWatch ? '' : 'none';
    $('#wrap').hidden = !cfg.open;
    $('#fab').hidden = cfg.open;
    const playing = video && !video.paused;
    const pp = $('#play');
    if (inGap) pp.innerHTML = html('<span class="big">' + gapLeft + '</span><small>준비…</small>');
    else pp.innerHTML = html(playing ? '❚❚<small>정지</small>' : '▶<small>재생</small>');
    pp.classList.toggle('on', !!playing && !inGap);
    $('#rate').textContent = st.rate + '%';
    $('#aT').textContent = st.A != null ? fmt(st.A) : '시작점';
    $('#bT').textContent = st.B != null ? fmt(st.B) : '끝점';
    $('#loop').textContent = st.loopOn ? '반복 ON' : '반복 OFF';
    $('#loop').classList.toggle('on', st.loopOn);
    $('#trOn').classList.toggle('on', tr.on);
    for (const id of Object.keys(trFields)) { const el = $('#' + id); if (root.activeElement !== el) el.value = cfg[id]; }
    $$('#gapSeg button').forEach(b => b.classList.toggle('on', +b.dataset.g === cfg.gap));
    $('#ci').checked = cfg.ci;
    const s = $('#trStat');
    let h;
    if (!tr.on) h = '<b>' + cfg.trStart + '%</b> → <b>' + cfg.trTarget + '%</b> · ' + cfg.trEvery + '번 반복마다 +' + cfg.trStep + '%';
    else if (st.rate >= cfg.trTarget) h = '<b>' + st.rate + '%</b> 도달! 이 속도로 계속 반복해요.';
    else h = '지금 <b>' + st.rate + '%</b> → 목표 ' + cfg.trTarget + '% · 다음 단계까지 <b>' + (cfg.trEvery - tr.done) + '번</b>' + (loopActive() ? '' : ' (A·B 필요)');
    s.innerHTML = html(h);
    root.host.style.setProperty('--h', ($('#wrap').offsetHeight || 0) + 'px');
  }
  function info() {
    const el = $('#info');
    if (!video) { el.textContent = '영상을 찾는 중…'; return; }
    const ad = adShowing() ? ' · 광고 중' : '';
    el.textContent = fmt(video.currentTime) + (loopActive() ? ' · ' + st.loops + '회 반복' : (st.A != null ? ' · A ' + fmt(st.A) : '')) + (tr.on ? ' · 자동↑' : '') + ad;
  }

  // ---------- main loop ----------
  let lastInfo = 0;
  function tick() {
    const id = videoIdFromUrl();
    if (id !== st.id) {
      if (id) loadVideoState(id); else { st.id = null; ui(); }
    }
    const v = findVideo();
    if (v !== video) {
      video = v;
      if (video) {
        video.addEventListener('play', ui); video.addEventListener('pause', ui);
        video.addEventListener('loadeddata', applyRate);
        // YouTube resets speed on its own (new video, quality change). Keep ours unless an ad is playing.
        video.addEventListener('ratechange', () => {
          if (adShowing() || performance.now() - rateGuard < 50) return;
          if (Math.abs(video.playbackRate - st.rate / 100) > 0.001) applyRate();
        });
        applyRate(); ui();
      }
    }
    if (video && st.id && !adShowing()) {
      if (Math.abs(video.playbackRate - st.rate / 100) > 0.001) applyRate();
      if (loopActive() && !inGap && !video.paused && performance.now() - lastLoop > 250 && video.currentTime >= st.B) loopEnd();
    }
    const now = performance.now();
    if (now - lastInfo > 100) { lastInfo = now; info(); }
    requestAnimationFrame(tick);
  }

  (async () => {
    Object.assign(cfg, await store.get('pp:cfg', {}));
    document.documentElement.appendChild(host);
    ui();
    requestAnimationFrame(tick);
  })();
})();
