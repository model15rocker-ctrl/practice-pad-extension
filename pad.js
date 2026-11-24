// 카피 연습 패드 for YouTube — content script (works on www.youtube.com and m.youtube.com)
// Controls the page's own <video>: A-B loop, pitch-preserving speed, step-up speed trainer, count-in,
// saved named sections per song (with their speed), song library, range bars.
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
  const cfg = { gap: 0, ci: true, trStart: 60, trTarget: 100, trStep: 5, trEvery: 3, open: true, lat: 0.3, back: 5 };
  // secs: saved sections of this song [{n: name, A, B, r: rate%}], cur: index of the section being edited (-1 = unsaved)
  const st = { id: null, A: null, B: null, loopOn: true, rate: 100, loops: 0, secs: [], cur: -1, title: '' };
  const tr = { on: false, done: 0, reached: false };
  let lib = {}; // song library: videoId -> { t: title, n: section count, u: last used }
  let video = null, inGap = false, gapLeft = 0, gapTimers = [], lastLoop = 0, rateGuard = 0;
  let markStage = 0; // one-button marking: 0 = next press sets A, 1 = next press sets B
  let drag = null;   // range-bar drag in progress
  let panel = '';    // '', 'set' or 'lib'
  let libTab = 'song';

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
  function pageTitle() {
    let t = document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube\s*$/, '').trim();
    if (!t || t === 'YouTube') {
      const h = document.querySelector('h1.ytd-watch-metadata, .ytVideoMetadataViewModelTitle, .slim-video-information-title');
      t = h ? h.textContent.trim() : '';
    }
    return t && t !== 'YouTube' ? t : '';
  }
  const dur = () => (video && isFinite(video.duration) && video.duration > 0 ? video.duration : 0);

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
.top{display:flex;align-items:center;gap:6px;font-size:13px}
.ttl{font-weight:800;color:#f5a524;white-space:nowrap}
.info{flex:1;color:#8d95a1;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ib{background:#232830;border-radius:8px;padding:6px 9px;font-size:13px;white-space:nowrap}
.ib.on{background:#f5a524;color:#1a1200}
.body{margin-top:6px;display:grid;gap:6px}
.row{display:grid;gap:6px}
.r5{grid-template-columns:1fr 1fr 1.3fr 1fr 1fr}
.r2{grid-template-columns:1fr 1fr}
.r3{grid-template-columns:1fr 1fr 1fr}
.sb{background:#232830;border-radius:10px;padding:8px 0;font-size:14px;font-weight:700}
.rate{display:flex;align-items:center;justify-content:center;color:#f5a524;font-weight:800;font-size:18px;font-variant-numeric:tabular-nums}
.pb{border-radius:14px;background:#232830;font-size:22px;font-weight:800;height:clamp(58px,9.5vh,88px);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;user-select:none}
.pb small{font-size:12px;font-weight:600;color:#8d95a1;font-variant-numeric:tabular-nums}
.pb:active,.sb:active,.ib:active{filter:brightness(1.4)}
.play{background:#123b2a;color:#2fcf8a}.play.on{background:#2a3038;color:#eceff2}
.play .big{font-size:32px;color:#f5a524;line-height:1}
.ab{background:#2d2410;color:#f5a524}.ab.wait{background:#4a3608;box-shadow:inset 0 0 0 2px #f5a524}
.rp{background:#1d2a3d;color:#7fb4ff}
.loop.on{background:#3a2c0c;color:#f5a524}
.save{background:#1f2f22;color:#7ee2a8}
.bars{display:grid;gap:3px;user-select:none}
.bar{position:relative;border-radius:8px;background:#1b1f25;touch-action:none;cursor:pointer;overflow:hidden}
.full{height:18px;background:#2a2f37}.zoom{height:38px;background:#20252c;box-shadow:inset 0 0 0 1px #2a2f37}
.ticks{position:absolute;inset:0;background-image:linear-gradient(to right,#ffffff1f 1px,transparent 1px);pointer-events:none}
.rng{position:absolute;top:0;bottom:0;background:#f5a52440;border-left:2px solid #f5a524;border-right:2px solid #f5a524;pointer-events:none}
.ph{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:#eceff2;pointer-events:none}
.hd{position:absolute;top:0;bottom:0;width:22px;margin-left:-11px;pointer-events:none;display:flex;align-items:flex-end;justify-content:center}
.hd i{font-style:normal;font-size:10px;font-weight:800;background:#f5a524;color:#1a1200;border-radius:4px;padding:0 4px;margin-bottom:2px}
.full .hd i{display:none}
.zl{display:flex;justify-content:space-between;font-size:11px;color:#8d95a1;font-variant-numeric:tabular-nums;padding:0 2px}
.zl b{color:#f5a524}
.set,.lib{background:#191c21;border:1px solid #2a2f37;border-radius:12px;padding:8px;display:grid;gap:8px;font-size:13px;max-height:46vh;overflow:auto}
.set label{display:flex;align-items:center;gap:6px;color:#8d95a1}
.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.g4 label{flex-direction:column;align-items:stretch;gap:2px;font-size:11px}
.g4 input{width:100%;background:#232830;border:1px solid #2a2f37;border-radius:8px;color:#eceff2;padding:6px 4px;text-align:center;font-size:15px}
.seg{display:grid;grid-template-columns:repeat(5,1fr);gap:4px}
.seg.s4{grid-template-columns:repeat(4,1fr)}
.seg button{background:#232830;border-radius:8px;padding:6px 0;font-size:12px}
.seg button.on{background:#f5a524;color:#1a1200;font-weight:800}
.nud{display:grid;grid-template-columns:auto 1fr 1fr 1fr 1fr;gap:4px;align-items:center}
.nud button{background:#232830;border-radius:8px;padding:6px 0;font-size:12px}
.stat{color:#eceff2;line-height:1.5}.stat b{color:#f5a524}
.sw{width:42px;height:24px;border-radius:24px;background:#2a2f37;position:relative;flex:none}
.sw.on{background:#f5a524}.sw::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.15s}
.sw.on::after{left:21px}
.tabs{display:grid;grid-template-columns:1fr 1fr;gap:4px}
.tabs button{background:#232830;border-radius:8px;padding:7px 0;font-size:13px;font-weight:700}
.tabs button.on{background:#f5a524;color:#1a1200}
.list{display:grid;gap:4px}
.it{display:flex;align-items:center;gap:4px;background:#232830;border-radius:10px;padding:4px 4px 4px 0}
.it.on{box-shadow:inset 0 0 0 2px #f5a524}
.it .go{flex:1;text-align:left;background:none;padding:6px 8px;min-width:0}
.it .go b{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.it .go small{color:#8d95a1;font-size:12px;font-variant-numeric:tabular-nums}
.it .x{background:#2d333c;border-radius:8px;padding:7px 9px;font-size:13px}
.it .x.warn{background:#7a1f1f;color:#fff}
.empty{color:#8d95a1;font-size:12px;line-height:1.5;padding:4px 2px}
.fab{pointer-events:auto;position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));background:#f5a524;color:#1a1200;font-weight:800;border-radius:999px;padding:10px 14px;box-shadow:0 4px 16px #0008;font-size:14px}
.toast{position:fixed;left:50%;bottom:calc(var(--h,300px) + 10px);transform:translateX(-50%);background:#eceff2;color:#111;font-weight:700;font-size:13px;padding:7px 14px;border-radius:999px;opacity:0;transition:.2s;pointer-events:none;white-space:nowrap;max-width:94vw;overflow:hidden;text-overflow:ellipsis}
.toast.show{opacity:1}
[hidden]{display:none!important}
</style>
<div class="toast" id="toast"></div>
<button class="fab" id="fab" hidden>🎸 연습</button>
<div class="wrap" id="wrap">
  <div class="top">
    <span class="ttl">🎸</span>
    <span class="info" id="info"></span>
    <button class="ib" id="libBtn">📁 구간</button>
    <button class="ib" id="gear">⚙</button>
    <button class="ib" id="min">▾</button>
  </div>
  <div class="body">
    <div class="lib" id="lib" hidden>
      <div class="tabs"><button data-tab="song">이 곡 구간</button><button data-tab="all">곡 목록</button></div>
      <div id="tabSong">
        <div class="list" id="secList"></div>
        <div class="row r2" style="margin-top:6px"><button class="sb save" id="add2">＋ 지금 구간 저장</button><button class="sb" id="clear">구간 지우기</button></div>
      </div>
      <div id="tabAll" hidden><div class="list" id="songList"></div></div>
    </div>
    <div class="set" id="set" hidden>
      <div style="display:flex;align-items:center;justify-content:space-between"><b>단계별 속도 올리기</b><button class="sw" id="trOn"></button></div>
      <div class="g4">
        <label>시작 %<input type="number" id="trStart" min="25" max="200"></label>
        <label>목표 %<input type="number" id="trTarget" min="25" max="200"></label>
        <label>올림 %<input type="number" id="trStep" min="1" max="25"></label>
        <label>몇 번마다<input type="number" id="trEvery" min="1" max="20"></label>
      </div>
      <div class="stat" id="trStat"></div>
      <div><b>늦게 누름 보정</b> <span style="color:#8d95a1">(A를 찍을 때 이만큼 앞당김)</span></div>
      <div class="seg s4" id="latSeg"><button data-v="0">없음</button><button data-v="0.15">0.15초</button><button data-v="0.3">0.3초</button><button data-v="0.5">0.5초</button></div>
      <div><b>"방금 거 다시" 길이</b></div>
      <div class="seg" id="backSeg"><button data-v="3">3초</button><button data-v="5">5초</button><button data-v="8">8초</button><button data-v="10">10초</button><button data-v="15">15초</button></div>
      <div><b>반복 사이 쉬기 · 카운트인</b></div>
      <div class="seg" id="gapSeg"><button data-v="0">없음</button><button data-v="1">1초</button><button data-v="2">2초</button><button data-v="3">3초</button><button data-v="4">4초</button></div>
      <label><input type="checkbox" id="ci"> 쉬는 동안 삑 소리</label>
      <div class="nud"><span>A</span><button data-w="A" data-d="-0.5">−0.5</button><button data-w="A" data-d="-0.05">−0.05</button><button data-w="A" data-d="0.05">+0.05</button><button data-w="A" data-d="0.5">+0.5</button></div>
      <div class="nud"><span>B</span><button data-w="B" data-d="-0.5">−0.5</button><button data-w="B" data-d="-0.05">−0.05</button><button data-w="B" data-d="0.05">+0.05</button><button data-w="B" data-d="0.5">+0.5</button></div>
      <div style="color:#8d95a1;font-size:12px;line-height:1.6">페달/키보드: ← PageUp 구간 처음 · → PageDown 재생/정지 · Enter 또는 M = A·B 찍기 · R = 방금 거 다시 · [ ] A/B 따로 · ↑ ↓ 속도</div>
    </div>
    <div class="bars">
      <div class="bar full" id="full"><div class="rng"></div><div class="ph"></div><div class="hd a"><i>A</i></div><div class="hd b"><i>B</i></div></div>
      <div class="zl"><span id="zLo"></span><span id="zMid"></span><span id="zHi"></span></div>
      <div class="bar zoom" id="zoom"><div class="ticks"></div><div class="rng"></div><div class="ph"></div><div class="hd a"><i>A</i></div><div class="hd b"><i>B</i></div></div>
    </div>
    <div class="row r5">
      <button class="sb" data-r="-5">−5</button><button class="sb" data-r="-1">−1</button>
      <div class="rate" id="rate">100%</div>
      <button class="sb" data-r="1">+1</button><button class="sb" data-r="5">+5</button>
    </div>
    <div class="row r3">
      <button class="sb loop on" id="loop">반복 ON</button>
      <button class="sb save" id="add">＋ 구간 저장</button>
      <button class="sb" id="r100">100%로</button>
    </div>
    <div class="row r2">
      <button class="pb" id="back">⟲<small>구간 처음</small></button>
      <button class="pb play" id="play">▶<small>재생</small></button>
    </div>
    <div class="row r2">
      <button class="pb ab" id="mk"><span id="mkT">A·B 찍기</span><small id="mkS">누르면 A</small></button>
      <button class="pb rp" id="rp">↺<small id="rpS">방금 5초 다시</small></button>
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
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1600);
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
  // A reaction-time correction, in video seconds (only while playing: when paused the spot was chosen deliberately).
  const latency = () => (video && !video.paused ? (cfg.lat || 0) * st.rate / 100 : 0);
  function newRange() { st.cur = -1; st.loops = 0; tr.done = 0; }
  function setA() {
    if (!video) return;
    const t = Math.max(0, video.currentTime - latency());
    newRange(); st.A = t; markStage = 1;
    if (st.B != null && st.B <= t + 0.05) st.B = null;
    save(); ui(); toast('A ' + fmt(t) + ' · 끝나는 곳에서 한 번 더');
  }
  function setB() {
    if (!video) return;
    const t = video.currentTime;
    if (st.A == null) st.A = 0;
    if (t <= st.A + 0.1) { toast('B는 A보다 뒤에서 눌러 주세요'); return; }
    if (st.cur >= 0 && markStage === 0) newRange();
    st.B = t; st.loops = 0; tr.done = 0; markStage = 0; save();
    if (st.loopOn) { toast('구간 ' + fmt(st.A) + '–' + fmt(st.B) + ' 반복'); goA(true); }
    else { toast('B 지점 ' + fmt(t)); ui(); }
  }
  // One button / one pedal: first press = A, second press = B.
  function mark() {
    if (!video) return; unlock();
    if (markStage === 0 || st.A == null) setA(); else setB();
  }
  // "방금 거 다시": loop the last few seconds right away.
  function replay() {
    if (!video) return; unlock();
    const t = video.currentTime, n = cfg.back;
    if (t < 0.5) { toast('조금 더 재생한 뒤 눌러 주세요'); return; }
    newRange(); st.A = Math.max(0, t - n); st.B = t; markStage = 0; st.loopOn = true;
    save(); toast('방금 ' + n + '초 반복'); goA(true);
  }
  function toggleLoop() { st.loopOn = !st.loopOn; save(); ui(); toast(st.loopOn ? '구간 반복 켜짐' : '구간 반복 꺼짐'); }

  // ---------- saved sections & song library ----------
  function addSection() {
    if (!(st.A != null && st.B != null && st.B > st.A)) { toast('먼저 A·B 구간을 정하세요'); return; }
    let k = st.secs.length + 1, n;
    do { n = '구간 ' + k++; } while (st.secs.some(s => s.n === n));
    st.secs.push({ n, A: st.A, B: st.B, r: st.rate });
    st.cur = st.secs.length - 1; markStage = 0;
    save(); renderLists(); ui(); toast('"' + n + '" 저장됨 (📁에서 이름 바꾸기)');
  }
  function useSection(i) {
    const s = st.secs[i]; if (!s) return;
    st.cur = i; st.A = s.A; st.B = s.B; st.loops = 0; tr.done = 0; tr.reached = false; markStage = 0; st.loopOn = true;
    setRate(s.r || 100, true);
    save(); renderLists();
    goA(!!video && !video.paused);
    toast(s.n + ' · ' + st.rate + '%');
  }
  function renameSection(i) {
    const s = st.secs[i]; if (!s) return;
    const v = window.prompt('구간 이름', s.n);
    if (v == null) return;
    s.n = v.trim().slice(0, 40) || s.n; save(); renderLists();
  }
  let delArm = null, delT;
  function deleteSection(i, btn) {
    if (delArm !== btn) { // first tap arms, second tap deletes
      if (delArm) { delArm.textContent = '🗑'; delArm.classList.remove('warn'); }
      delArm = btn; btn.textContent = '삭제?'; btn.classList.add('warn');
      clearTimeout(delT); delT = setTimeout(() => { if (delArm) { delArm.textContent = '🗑'; delArm.classList.remove('warn'); delArm = null; } }, 2500);
      return;
    }
    delArm = null;
    const name = st.secs[i].n;
    st.secs.splice(i, 1);
    if (st.cur === i) st.cur = -1; else if (st.cur > i) st.cur--;
    save(); renderLists(); ui(); toast('"' + name + '" 삭제됨');
  }
  function openSong(id) {
    if (id === st.id) { libTab = 'song'; renderLists(); return; }
    location.href = location.origin + '/watch?v=' + encodeURIComponent(id);
  }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function renderLists() {
    $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === libTab));
    $('#tabSong').hidden = libTab !== 'song';
    $('#tabAll').hidden = libTab !== 'all';
    const sl = $('#secList'); sl.textContent = '';
    if (!st.secs.length) sl.appendChild(el('div', 'empty', '저장한 구간이 없어요. A·B를 정한 뒤 "＋ 구간 저장"을 누르면 이 곡에 이름 붙여 저장돼요. 구간마다 속도도 같이 기억해요.'));
    st.secs.forEach((s, i) => {
      const it = el('div', 'it' + (i === st.cur ? ' on' : ''));
      const go = el('button', 'go'); go.appendChild(el('b', '', s.n)); go.appendChild(el('small', '', fmt(s.A) + ' – ' + fmt(s.B) + ' · ' + (s.r || 100) + '%'));
      go.addEventListener('click', () => useSection(i));
      const rn = el('button', 'x', '✎'); rn.addEventListener('click', () => renameSection(i));
      const dl = el('button', 'x', '🗑'); dl.addEventListener('click', () => deleteSection(i, dl));
      it.append(go, rn, dl); sl.appendChild(it);
    });
    const gl = $('#songList'); gl.textContent = '';
    const ids = Object.keys(lib).sort((a, b) => (lib[b].u || 0) - (lib[a].u || 0));
    if (!ids.length) gl.appendChild(el('div', 'empty', '구간을 저장한 곡이 여기에 모여요. 누르면 그 곡이 열리고, 마지막에 연습하던 구간이 바로 잡혀요.'));
    ids.forEach(id => {
      const L = lib[id];
      const it = el('div', 'it' + (id === st.id ? ' on' : ''));
      const go = el('button', 'go'); go.appendChild(el('b', '', L.t || id)); go.appendChild(el('small', '', '구간 ' + (L.n || 0) + '개' + (id === st.id ? ' · 지금 보는 곡' : '')));
      go.addEventListener('click', () => openSong(id));
      it.appendChild(go); gl.appendChild(it);
    });
  }

  // ---------- persistence ----------
  let libT;
  function save() {
    if (!st.id) return;
    const c = st.secs[st.cur];
    if (c) { if (st.A != null && st.B != null && st.B > st.A) { c.A = st.A; c.B = st.B; } c.r = st.rate; }
    const t = pageTitle(); if (t) st.title = t;
    store.set('pp:v:' + st.id, { A: st.A, B: st.B, rate: st.rate, loopOn: st.loopOn, secs: st.secs, cur: st.cur, title: st.title });
    clearTimeout(libT); libT = setTimeout(syncLib, 300);
    if (panel === 'lib' && !delArm) renderLists();
  }
  async function syncLib() {
    if (!st.id) return;
    const L = await store.get('pp:lib', {});
    if (st.secs.length) L[st.id] = { t: st.title || (L[st.id] && L[st.id].t) || st.id, n: st.secs.length, u: Date.now() };
    else delete L[st.id];
    lib = L; store.set('pp:lib', L);
    if (panel === 'lib') renderLists();
  }
  function saveCfg() { store.set('pp:cfg', cfg); }
  async function loadVideoState(id) {
    clearGap();
    st.id = id; st.A = st.B = null; st.loops = 0; st.rate = 100; st.loopOn = true; st.secs = []; st.cur = -1; st.title = '';
    tr.done = 0; tr.reached = false; markStage = 0;
    const d = await store.get('pp:v:' + id, null);
    if (d && st.id === id) {
      st.A = d.A ?? null; st.B = d.B ?? null; st.rate = d.rate || 100; st.loopOn = d.loopOn !== false;
      st.secs = Array.isArray(d.secs) ? d.secs : [];
      st.cur = Number.isInteger(d.cur) && d.cur < st.secs.length ? d.cur : -1;
      st.title = d.title || '';
    }
    if (tr.on && st.cur < 0) st.rate = cfg.trStart;
    lib = await store.get('pp:lib', {});
    applyRate(); renderLists(); ui();
    if (st.cur >= 0) toast('"' + st.secs[st.cur].n + '" 이어서 연습');
  }

  // ---------- range bars (full song + zoomed around the section) ----------
  function zoomWin() {
    if (drag && drag.bar === 'zoom') return [drag.lo, drag.hi];
    const d = dur(); if (!d) return [0, 1];
    let lo, hi;
    if (st.A != null && st.B != null && st.B > st.A) { const p = clamp((st.B - st.A) * 0.4, 2, 8); lo = st.A - p; hi = st.B + p; }
    else if (st.A != null) { lo = st.A - 4; hi = st.A + 12; }
    else { const t = video.currentTime; lo = t - 8; hi = t + 8; }
    if (hi - lo > d) return [0, d];
    if (lo < 0) { hi -= lo; lo = 0; }
    if (hi > d) { lo -= hi - d; hi = d; }
    return [lo, hi];
  }
  const winOf = name => (name === 'full' ? (drag && drag.bar === 'full' ? [drag.lo, drag.hi] : [0, dur() || 1]) : zoomWin());
  function renderBar(name) {
    const b = $('#' + name), [lo, hi] = winOf(name), span = hi - lo || 1;
    const P = t => ((t - lo) / span * 100) + '%';
    const hasA = st.A != null, hasB = st.B != null && hasA && st.B > st.A;
    const rng = b.querySelector('.rng'), ha = b.querySelector('.hd.a'), hb = b.querySelector('.hd.b'), ph = b.querySelector('.ph');
    rng.hidden = !hasB; ha.hidden = !hasA; hb.hidden = !hasB;
    if (hasB) { rng.style.left = P(st.A); rng.style.width = ((st.B - st.A) / span * 100) + '%'; }
    if (hasA) ha.style.left = P(st.A);
    if (hasB) hb.style.left = P(st.B);
    ph.style.left = video ? P(video.currentTime) : '0%';
    if (name === 'zoom') {
      const w = b.clientWidth, pps = w / span, tk = b.querySelector('.ticks');
      tk.style.backgroundSize = pps + 'px 100%';
      tk.style.backgroundPosition = (-(lo % 1) * pps) + 'px 0';
      $('#zLo').textContent = fmt(lo);
      $('#zHi').textContent = fmt(hi);
      const m = $('#zMid');
      if (hasB) m.innerHTML = html('<b>A</b> ' + fmt(st.A, 2) + ' · <b>B</b> ' + fmt(st.B, 2) + ' (' + (st.B - st.A).toFixed(1) + '초)');
      else if (hasA) m.innerHTML = html('<b>A</b> ' + fmt(st.A, 2) + ' · B를 정하세요');
      else m.textContent = '막대를 끌어서 구간 잡기';
    }
  }
  function renderBars() { if (!cfg.open || !st.id) return; renderBar('full'); renderBar('zoom'); }
  function barTime(d, x) { const r = d.el.getBoundingClientRect(); return d.lo + clamp((x - r.left) / r.width, 0, 1) * (d.hi - d.lo); }
  function onDown(name, e) {
    if (!video || !dur() || (e.button != null && e.button > 0)) return;
    const elb = $('#' + name), [lo, hi] = winOf(name), r = elb.getBoundingClientRect();
    const d = { bar: name, el: elb, lo, hi, mode: 'new', x0: e.clientX, moved: false, id: e.pointerId };
    d.anchor = barTime(d, e.clientX);
    const px = t => r.left + (t - lo) / (hi - lo) * r.width;
    const dA = st.A != null ? Math.abs(e.clientX - px(st.A)) : 1e9;
    const dB = st.B != null && st.A != null && st.B > st.A ? Math.abs(e.clientX - px(st.B)) : 1e9;
    if (Math.min(dA, dB) < 20) d.mode = dA <= dB ? 'A' : 'B';
    drag = d;
    try { elb.setPointerCapture(e.pointerId); } catch (er) {}
    e.preventDefault();
  }
  function onMove(e) {
    const d = drag; if (!d || e.pointerId !== d.id) return;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 5) return;
    d.moved = true;
    const t = barTime(d, e.clientX), D = dur();
    if (d.mode === 'A') st.A = clamp(t, 0, st.B != null && st.B > st.A ? st.B - 0.05 : D);
    else if (d.mode === 'B') st.B = clamp(t, st.A + 0.05, D);
    else {
      if (!d.started) { d.started = true; newRange(); markStage = 0; }
      st.A = Math.min(d.anchor, t); st.B = Math.max(d.anchor, t);
      if (st.B - st.A < 0.05) st.B = Math.min(D, st.A + 0.05);
    }
    renderBars();
  }
  function onUp(e) {
    const d = drag; if (!d || e.pointerId !== d.id) return;
    drag = null;
    if (!d.moved) { seek(d.anchor); lastLoop = performance.now(); }
    else {
      st.loops = 0; tr.done = 0; save();
      if (d.mode !== 'B') goA(!!video && !video.paused);
      else if (video && video.currentTime > st.B) goA(!video.paused);
    }
    ui();
  }
  ['full', 'zoom'].forEach(n => {
    const b = $('#' + n);
    b.addEventListener('pointerdown', e => onDown(n, e));
    b.addEventListener('pointermove', onMove);
    b.addEventListener('pointerup', onUp);
    b.addEventListener('pointercancel', onUp);
  });

  // Mark the section on YouTube's own progress bar too.
  const ytMark = document.createElement('div');
  ytMark.id = 'practice-pad-range';
  ytMark.style.cssText = 'position:absolute;top:0;bottom:0;height:100%;background:rgba(245,165,36,.6);pointer-events:none;z-index:40;border-radius:1px;';
  function renderYT() {
    const bar = document.querySelector('.ytp-progress-bar') ||
      document.querySelector('.ytChapteredProgressBarHost, yt-chaptered-progress-bar-line');
    const D = dur();
    if (!bar || !D || st.A == null || st.B == null || st.B <= st.A) { ytMark.style.display = 'none'; return; }
    if (ytMark.parentNode !== bar) bar.appendChild(ytMark);
    ytMark.style.display = '';
    ytMark.style.left = (st.A / D * 100) + '%';
    ytMark.style.width = ((st.B - st.A) / D * 100) + '%';
  }

  // ---------- wiring ----------
  $$('[data-r]').forEach(b => b.addEventListener('click', () => setRate(st.rate + parseInt(b.dataset.r, 10))));
  $('#r100').addEventListener('click', () => setRate(100));
  $('#loop').addEventListener('click', toggleLoop);
  $('#add').addEventListener('click', addSection);
  $('#add2').addEventListener('click', addSection);
  $('#clear').addEventListener('click', () => { newRange(); st.A = st.B = null; markStage = 0; save(); renderLists(); ui(); toast('구간을 지웠어요'); });
  $('#back').addEventListener('click', () => goA(true));
  $('#play').addEventListener('click', togglePlay);
  $('#mk').addEventListener('click', mark);
  $('#rp').addEventListener('click', replay);
  const showPanel = p => { panel = panel === p ? '' : p; if (panel === 'lib') { libTab = 'song'; renderLists(); } ui(); };
  $('#gear').addEventListener('click', () => showPanel('set'));
  $('#libBtn').addEventListener('click', () => showPanel('lib'));
  $$('.tabs button').forEach(b => b.addEventListener('click', async () => { libTab = b.dataset.tab; if (libTab === 'all') lib = await store.get('pp:lib', {}); renderLists(); }));
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
    const inp = $('#' + id);
    inp.addEventListener('change', () => {
      let x = parseInt(inp.value, 10); if (!isFinite(x)) x = cfg[id];
      cfg[id] = clamp(x, lo, hi); inp.value = cfg[id]; saveCfg(); ui();
    });
    inp.addEventListener('keydown', e => e.stopPropagation());
  }
  const segs = { gapSeg: 'gap', latSeg: 'lat', backSeg: 'back' };
  for (const [sid, key] of Object.entries(segs))
    $$('#' + sid + ' button').forEach(b => b.addEventListener('click', () => { cfg[key] = +b.dataset.v; saveCfg(); ui(); }));
  $('#ci').addEventListener('change', e => { cfg.ci = e.target.checked; saveCfg(); });
  $$('.nud button').forEach(b => b.addEventListener('click', () => {
    const w = b.dataset.w, d = parseFloat(b.dataset.d);
    if (st[w] == null) { toast(w + ' 지점을 먼저 정하세요'); return; }
    const D = dur() || 1e9;
    if (w === 'A') st.A = clamp(st.A + d, 0, st.B != null ? st.B - 0.05 : D);
    else st.B = clamp(st.B + d, (st.A ?? 0) + 0.05, D);
    save(); ui();
  }));
  // Keep our clicks from reaching YouTube's own handlers.
  ['click', 'mousedown', 'pointerdown', 'touchstart', 'keydown', 'keyup'].forEach(ev =>
    host.addEventListener(ev, e => e.stopPropagation()));

  // Pedal / keyboard (capture phase so YouTube doesn't also act on these keys)
  const keyMap = { ArrowLeft: 'back', PageUp: 'back', ArrowRight: 'play', PageDown: 'play', Enter: 'mark', m: 'mark', M: 'mark',
    r: 'replay', R: 'replay', '[': 'A', ']': 'B', ArrowUp: 'up', ArrowDown: 'down' };
  window.addEventListener('keydown', e => {
    const act = keyMap[e.key];
    if (!cfg.open || !st.id || !act || e.ctrlKey || e.altKey || e.metaKey) return;
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (act === 'mark' && e.key === 'Enter' && t && t !== document.body && t.tagName === 'BUTTON' && !host.contains(t)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.repeat && act !== 'up' && act !== 'down') return;
    switch (act) {
      case 'back': goA(true); break;
      case 'play': togglePlay(); break;
      case 'mark': mark(); break;
      case 'replay': replay(); break;
      case 'A': setA(); break;
      case 'B': setB(); break;
      case 'up': setRate(st.rate + 5); toast('속도 ' + st.rate + '%'); break;
      case 'down': setRate(st.rate - 5); toast('속도 ' + st.rate + '%'); break;
    }
  }, true);

  // ---------- render ----------
  function ui() {
    const onWatch = !!st.id;
    host.style.display = onWatch ? '' : 'none';
    $('#wrap').hidden = !cfg.open;
    $('#fab').hidden = cfg.open;
    $('#set').hidden = panel !== 'set';
    $('#lib').hidden = panel !== 'lib';
    $('#gear').classList.toggle('on', panel === 'set');
    $('#libBtn').classList.toggle('on', panel === 'lib');
    const cs = st.secs[st.cur];
    $('#libBtn').textContent = '📁 ' + (cs ? cs.n : '구간') + (st.secs.length ? ' (' + st.secs.length + ')' : '');
    const playing = video && !video.paused;
    const pp = $('#play');
    if (inGap) pp.innerHTML = html('<span class="big">' + gapLeft + '</span><small>준비…</small>');
    else pp.innerHTML = html(playing ? '❚❚<small>정지</small>' : '▶<small>재생</small>');
    pp.classList.toggle('on', !!playing && !inGap);
    const waitB = markStage === 1 && st.A != null;
    $('#mk').classList.toggle('wait', waitB);
    $('#mkT').textContent = waitB ? 'B 찍기' : 'A·B 찍기';
    $('#mkS').textContent = waitB ? 'A ' + fmt(st.A) + ' · 끝에서 누르기' : (loopActive() ? fmt(st.A) + ' – ' + fmt(st.B) : '누르면 A');
    $('#rpS').textContent = '방금 ' + cfg.back + '초 다시';
    $('#add').textContent = cs ? '✓ ' + cs.n : '＋ 구간 저장';
    $('#rate').textContent = st.rate + '%';
    $('#loop').textContent = st.loopOn ? '반복 ON' : '반복 OFF';
    $('#loop').classList.toggle('on', st.loopOn);
    $('#trOn').classList.toggle('on', tr.on);
    for (const id of Object.keys(trFields)) { const inp = $('#' + id); if (root.activeElement !== inp) inp.value = cfg[id]; }
    for (const [sid, key] of Object.entries(segs)) $$('#' + sid + ' button').forEach(b => b.classList.toggle('on', +b.dataset.v === cfg[key]));
    $('#ci').checked = cfg.ci;
    let h;
    if (!tr.on) h = '<b>' + cfg.trStart + '%</b> → <b>' + cfg.trTarget + '%</b> · ' + cfg.trEvery + '번 반복마다 +' + cfg.trStep + '%';
    else if (st.rate >= cfg.trTarget) h = '<b>' + st.rate + '%</b> 도달! 이 속도로 계속 반복해요.';
    else h = '지금 <b>' + st.rate + '%</b> → 목표 ' + cfg.trTarget + '% · 다음 단계까지 <b>' + (cfg.trEvery - tr.done) + '번</b>' + (loopActive() ? '' : ' (A·B 필요)');
    $('#trStat').innerHTML = html(h);
    renderBars();
    root.host.style.setProperty('--h', ($('#wrap').offsetHeight || 0) + 'px');
  }
  function info() {
    const e = $('#info');
    if (!video) { e.textContent = '영상을 찾는 중…'; return; }
    const ad = adShowing() ? ' · 광고 중' : '';
    e.textContent = fmt(video.currentTime) + (loopActive() ? ' · ' + st.loops + '회' : '') + (tr.on ? ' · 자동↑' : '') + ad;
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
      if (loopActive() && !inGap && !drag && !video.paused && performance.now() - lastLoop > 250 && video.currentTime >= st.B) loopEnd();
    }
    const now = performance.now();
    if (now - lastInfo > 100) { lastInfo = now; info(); renderBars(); renderYT(); }
    requestAnimationFrame(tick);
  }

  (async () => {
    Object.assign(cfg, await store.get('pp:cfg', {}));
    lib = await store.get('pp:lib', {});
    document.documentElement.appendChild(host);
    ui();
    requestAnimationFrame(tick);
  })();
})();
