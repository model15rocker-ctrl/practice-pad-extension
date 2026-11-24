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
  const cfg = { gap: 0, ci: true, trStart: 60, trTarget: 100, trStep: 5, trEvery: 3, open: true, lat: 0.3 };
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
button{font:inherit;color:inherit;cursor:pointer;border:0;touch-action:manipulation;user-select:none}
.wrap{pointer-events:auto;position:fixed;left:0;right:0;bottom:0;background:#0b0d10;color:#eceff2;border-top:1px solid #222830;padding:4px 6px calc(4px + env(safe-area-inset-bottom))}
.in{max-width:820px;margin:0 auto;display:grid;gap:4px}
.ctl{display:flex;gap:4px;height:42px}
.ctl>*{flex:1 1 0;min-width:0}
.ctl .play,.ctl .ab{flex-grow:1.25}.ctl .rate{flex-grow:1.1}.ctl .sp,.ctl .more,.ctl .x2{flex-grow:.8}.ctl .clr{flex-grow:.85}
.ctl .clr{color:#ff8a7a;font-size:17px}
.ctl button{background:#1c2128;border-radius:9px;font-size:18px;font-weight:800;display:flex;align-items:center;justify-content:center;min-width:0}
.ctl button:active,.sheet button:active{filter:brightness(1.5)}
.ctl .play{background:#123b2a;color:#2fcf8a}.ctl .play.on{background:#262c34;color:#eceff2}
.ctl .ab{background:#2d2410;color:#f5a524;font-size:15px}.ctl .ab.wait{background:#5a4208;box-shadow:inset 0 0 0 2px #f5a524}
.ctl .sp{font-size:20px}
.ctl .more.on,.ctl .plb.on{background:#f5a524;color:#1a1200}
.plp{pointer-events:auto;position:fixed;top:0;right:0;bottom:var(--bh,100px);width:min(360px,86vw);background:#0b0d10;border-left:1px solid #222830;display:flex;flex-direction:column;color:#eceff2}
.plh{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 8px 6px 10px;font-size:13px}
.plh b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.plh button{background:#1c2128;border-radius:8px;padding:5px 10px;font-size:13px;flex:none}
#plList{overflow:auto;padding:0 6px 8px;flex:1;align-content:start}
#plList .go small{display:block}
.rate{display:flex;align-items:center;justify-content:center;color:#f5a524;font-weight:800;font-size:15px;font-variant-numeric:tabular-nums}
.bar{position:relative;border-radius:7px;background:#1b1f25;touch-action:none;cursor:pointer;overflow:hidden}
.full{height:22px;background:#20252c}.zoom{height:24px;background:#181c22;box-shadow:inset 0 0 0 1px #262c34}
.svs{position:absolute;inset:0;pointer-events:none}
.sv{position:absolute;top:0;bottom:0;min-width:3px;background:#4d7cff30;border-left:1px solid #6f9bff;border-right:1px solid #6f9bff;overflow:hidden;font-size:9px;line-height:10px;color:#b9ccff;padding:1px 2px;white-space:nowrap;text-overflow:clip}
.sv.on{background:none;border-color:transparent;color:#f5a524;z-index:1}
.ticks{position:absolute;inset:0;background-image:linear-gradient(to right,#ffffff1c 1px,transparent 1px);pointer-events:none}
.rng{position:absolute;top:0;bottom:0;background:#f5a52438;border-left:2px solid #f5a524;border-right:2px solid #f5a524;pointer-events:none}
.ph{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:#eceff2;pointer-events:none}
.hd{position:absolute;top:0;bottom:0;width:22px;margin-left:-11px;pointer-events:none;display:flex;align-items:flex-end;justify-content:center}
.hd i{font-style:normal;font-size:9px;font-weight:800;background:#f5a524;color:#1a1200;border-radius:3px;padding:0 3px;margin-bottom:1px}
.full .hd i{display:none}
.full .zt.r{top:auto;bottom:1px}
.zt{position:absolute;top:1px;font-size:9px;color:#6f7884;pointer-events:none;font-variant-numeric:tabular-nums}
.zt.l{left:4px}.zt.r{right:4px}
.sheet{position:absolute;left:0;right:0;bottom:100%;background:#0b0d10f2;border-top:1px solid #222830;padding:6px 6px 4px;max-height:70vh;overflow:auto}
.sheet .in{gap:6px}
.shead{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#8d95a1;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}
.shead b{color:#f5a524}
.row{display:grid;gap:5px}
.r6{grid-template-columns:repeat(6,1fr)}
.r4{grid-template-columns:repeat(4,1fr)}
.r2{grid-template-columns:1fr 1fr}
.sb{background:#1c2128;border-radius:9px;padding:8px 2px;font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sb.on{background:#f5a524;color:#1a1200}
.loop.on{background:#3a2c0c;color:#f5a524}
.save{background:#1f2f22;color:#7ee2a8}
.set,.lib{background:#14171c;border:1px solid #232830;border-radius:10px;padding:8px;display:grid;gap:8px;font-size:13px}
.set label{display:flex;align-items:center;gap:6px;color:#8d95a1}
.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.g4 label{flex-direction:column;align-items:stretch;gap:2px;font-size:11px}
.g4 input{width:100%;background:#1c2128;border:1px solid #2a2f37;border-radius:8px;color:#eceff2;padding:6px 4px;text-align:center;font-size:15px}
.seg{display:grid;grid-template-columns:repeat(5,1fr);gap:4px}
.seg.s4{grid-template-columns:repeat(4,1fr)}
.seg button{background:#1c2128;border-radius:8px;padding:6px 0;font-size:12px}
.seg button.on{background:#f5a524;color:#1a1200;font-weight:800}
.nud{display:grid;grid-template-columns:auto 1fr 1fr 1fr 1fr;gap:4px;align-items:center}
.nud button{background:#1c2128;border-radius:8px;padding:6px 0;font-size:12px}
.stat{color:#eceff2;line-height:1.5}.stat b{color:#f5a524}
.sw{width:42px;height:24px;border-radius:24px;background:#2a2f37;position:relative;flex:none}
.sw.on{background:#f5a524}.sw::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.15s}
.sw.on::after{left:21px}
.tabs{display:grid;grid-template-columns:1fr 1fr;gap:4px}
.tabs button{background:#1c2128;border-radius:8px;padding:7px 0;font-size:13px;font-weight:700}
.tabs button.on{background:#f5a524;color:#1a1200}
.list{display:grid;gap:4px}
.it{display:flex;align-items:center;gap:4px;background:#1c2128;border-radius:10px;padding:3px 4px 3px 0}
.it.on{box-shadow:inset 0 0 0 2px #f5a524}
.it .go{flex:1;text-align:left;background:none;padding:5px 8px;min-width:0}
.it .go b{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.it .go small{color:#8d95a1;font-size:12px;font-variant-numeric:tabular-nums}
.it .x{background:#2a3038;border-radius:8px;padding:7px 9px;font-size:13px}
.it .x.warn{background:#7a1f1f;color:#fff}
.empty{color:#8d95a1;font-size:12px;line-height:1.5;padding:4px 2px}
.fab{pointer-events:auto;position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));background:#f5a524;color:#1a1200;font-weight:800;border-radius:999px;padding:10px 14px;box-shadow:0 4px 16px #0008;font-size:14px}
.toast{position:fixed;left:50%;bottom:calc(var(--h,90px) + 8px);transform:translateX(-50%);background:#eceff2;color:#111;font-weight:700;font-size:13px;padding:6px 12px;border-radius:999px;opacity:0;transition:.2s;pointer-events:none;white-space:nowrap;max-width:94vw;overflow:hidden;text-overflow:ellipsis}
.toast.show{opacity:1}
[hidden]{display:none!important}
</style>
<div class="toast" id="toast"></div>
<button class="fab" id="fab" hidden>🎸 연습 화면</button>
<div class="plp" id="plp" hidden><div class="plh"><b id="plT">재생목록</b><button id="plX">닫기</button></div><div class="list" id="plList"></div></div>
<div class="wrap" id="wrap">
  <div class="sheet" id="sheet" hidden><div class="in">
    <div class="shead"><span id="info"></span><span id="zMid"></span></div>
    <div class="row r6">
      <button class="sb" data-r="-5">−5</button><button class="sb" data-r="-1">−1</button><button class="sb" data-r="1">+1</button><button class="sb" data-r="5">+5</button>
      <button class="sb" id="r100">100%</button><button class="sb loop on" id="loop">반복</button>
    </div>
    <div class="row r4">
      <button class="sb save" id="add">＋ 저장</button><button class="sb" id="libBtn">📁 구간</button>
      <button class="sb" id="gear">⚙ 설정</button><button class="sb" id="fs">⛶ 전체</button>
    </div>
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
      <div><b>반복 사이 쉬기 · 카운트인</b></div>
      <div class="seg" id="gapSeg"><button data-v="0">없음</button><button data-v="1">1초</button><button data-v="2">2초</button><button data-v="3">3초</button><button data-v="4">4초</button></div>
      <label><input type="checkbox" id="ci"> 쉬는 동안 삑 소리</label>
      <div class="nud"><span>A</span><button data-w="A" data-d="-0.5">−0.5</button><button data-w="A" data-d="-0.05">−0.05</button><button data-w="A" data-d="0.05">+0.05</button><button data-w="A" data-d="0.5">+0.5</button></div>
      <div class="nud"><span>B</span><button data-w="B" data-d="-0.5">−0.5</button><button data-w="B" data-d="-0.05">−0.05</button><button data-w="B" data-d="0.05">+0.05</button><button data-w="B" data-d="0.5">+0.5</button></div>
      <div style="color:#8d95a1;font-size:12px;line-height:1.6">위 막대: 곡 전체 (누르거나 끌어서 이동, 파란색 = 저장한 구간, 누르면 불러오기) · 아래 막대: 구간 확대 (손잡이로 A·B 조절, 빈 곳을 끌면 새 구간)<br>아래 줄: ⟲ 구간 처음 · ▶ 재생 · A·B 찍기 · ⌫ 구간 지우기 · − + 속도 · ☰ 재생목록(있을 때) · ⋯ 더보기 · ✕ 연습 화면 닫기<br>페달/키보드: ← PageUp 구간 처음 · → PageDown 재생/정지 · Enter 또는 M = A·B 찍기 · Delete 구간 지우기 · [ ] A/B 따로 · + − 또는 ↑ ↓ 속도</div>
    </div>
  </div></div>
  <div class="in">
    <div class="bar full" id="full" title="곡 전체: 누르거나 끌어서 이동 · 저장한 구간(파란색)을 누르면 불러오기"><div class="svs" id="svs"></div><div class="rng"></div><div class="ph"></div><div class="hd a"><i>A</i></div><div class="hd b"><i>B</i></div><span class="zt r" id="fT"></span></div>
    <div class="bar zoom" id="zoom" title="구간 확대: A·B 손잡이를 끌어 미세 조정"><div class="ticks"></div><div class="rng"></div><div class="ph"></div><div class="hd a"><i>A</i></div><div class="hd b"><i>B</i></div><span class="zt l" id="zLo"></span><span class="zt r" id="zHi"></span></div>
    <div class="ctl">
      <button id="back" title="구간 처음">⟲</button>
      <button class="play" id="play" title="재생/정지">▶</button>
      <button class="ab" id="mk" title="A·B 찍기"><span id="mkT">A·B</span></button>
      <button class="clr" id="clr" title="A·B 구간 지우기">⌫</button>
      <button class="sp" data-r="-5" title="느리게">−</button>
      <span class="rate" id="rate">100%</span>
      <button class="sp" data-r="5" title="빠르게">+</button>
      <button class="plb x2" id="plBtn" title="재생목록" hidden>☰</button>
      <button class="more" id="more" title="더보기">⋯</button>
      <button class="x2" id="min" title="연습 화면 닫기">✕</button>
    </div>
  </div>
</div>`);
  const $ = s => root.querySelector(s), $$ = s => [...root.querySelectorAll(s)];

  // ---------- practice view: YouTube's player fills the screen above our control bar ----------
  const pageCss = document.createElement('style');
  pageCss.id = 'practice-pad-page-css';
  pageCss.textContent = [
    'html.pp-full,html.pp-full body{overflow:hidden!important}',
    'html.pp-full .pp-anc{z-index:2147483000!important;transform:none!important;contain:none!important;filter:none!important;will-change:auto!important}',
    'html.pp-full .pp-player{position:fixed!important;left:0!important;top:0!important;right:auto!important;bottom:auto!important;margin:0!important;width:calc(100vw - var(--pp-r,0px))!important;height:calc(100vh - var(--pp-h,80px))!important;height:calc(100dvh - var(--pp-h,80px))!important;max-width:none!important;max-height:none!important;z-index:2147483000!important;background:#000!important;transform:none!important}',
    'html.pp-full .pp-player .html5-video-container{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;transform:none!important}',
    'html.pp-full .pp-player video{position:absolute!important;left:0!important;top:0!important;width:100%!important;height:100%!important;object-fit:contain!important;transform:none!important}'
  ].join('\n');
  let fullOn = false, playerEl = null, ancMarked = [], lastAnc = 0;
  function findPlayer() {
    return (video && video.closest('.html5-video-player')) || document.querySelector('#movie_player');
  }
  function markAncestors() {
    const pl = findPlayer();
    if (pl !== playerEl) { if (playerEl) playerEl.classList.remove('pp-player'); playerEl = pl; }
    if (playerEl) playerEl.classList.add('pp-player');
    const want = [];
    for (let p = playerEl && playerEl.parentElement; p && p !== document.documentElement; p = p.parentElement) want.push(p);
    ancMarked.forEach(e => { if (!want.includes(e)) e.classList.remove('pp-anc'); });
    want.forEach(e => e.classList.add('pp-anc'));
    ancMarked = want;
  }
  function setFull(on) {
    if (on === fullOn) { if (on && performance.now() - lastAnc > 500) { lastAnc = performance.now(); markAncestors(); } return; }
    fullOn = on;
    if (on) {
      if (!pageCss.isConnected) (document.head || document.documentElement).appendChild(pageCss);
      markAncestors();
      document.documentElement.classList.add('pp-full');
    } else {
      document.documentElement.classList.remove('pp-full');
      ancMarked.forEach(e => e.classList.remove('pp-anc')); ancMarked = [];
      if (playerEl) playerEl.classList.remove('pp-player');
      playerEl = null;
    }
    // let YouTube re-measure its player (controls, captions) for the new size
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 400);
  }
  let sheetOpen = false;

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
    st.B = t; st.loops = 0; tr.done = 0; markStage = 0; st.loopOn = true; save();
    if (st.loopOn) { toast('구간 ' + fmt(st.A) + '–' + fmt(st.B) + ' 반복'); goA(true); }
    else { toast('B 지점 ' + fmt(t)); ui(); }
  }
  // One button / one pedal: first press = A, second press = B.
  function mark() {
    if (!video) return; unlock();
    if (markStage === 0 || st.A == null) setA(); else setB();
  }
  function toggleLoop() { st.loopOn = !st.loopOn; save(); ui(); toast(st.loopOn ? '구간 반복 켜짐' : '구간 반복 꺼짐'); }

  // ---------- saved sections & song library ----------
  function addSection() {
    if (!(st.A != null && st.B != null && st.B > st.A)) { toast('먼저 A·B 구간을 정하세요'); return; }
    let k = st.secs.length + 1, n;
    do { n = '구간 ' + k++; } while (st.secs.some(s => s.n === n));
    st.secs.push({ n, A: st.A, B: st.B, r: st.rate });
    st.cur = st.secs.length - 1; markStage = 0;
    save(); renderLists(); ui(); toast('"' + n + '" 저장됨 (⋯ → 📁에서 이름 바꾸기)');
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
    applyRate(); renderLists(); ui(); renderPlaylist(true);
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
  function renderBars() {
    if (!cfg.open || !st.id) return;
    renderBar('full'); renderBar('zoom'); renderSaved();
    $('#fT').textContent = video ? fmt(video.currentTime, 0) + ' / ' + fmt(dur(), 0) : '';
  }
  // Saved sections drawn on the whole-song bar (blue); the active one is shown by the orange range instead.
  let svKey = '';
  function renderSaved() {
    const D = dur(), key = D + '|' + st.cur + '|' + st.secs.map(s => s.n + ':' + s.A + ':' + s.B).join('|');
    if (key === svKey) return;
    svKey = key;
    const box = $('#svs'); box.textContent = '';
    if (!D) return;
    st.secs.forEach((s, i) => {
      const e = el('div', 'sv' + (i === st.cur ? ' on' : ''), s.n);
      e.style.left = (s.A / D * 100) + '%'; e.style.width = ((s.B - s.A) / D * 100) + '%';
      box.appendChild(e);
    });
  }
  function savedAt(t) {
    let best = -1;
    st.secs.forEach((s, i) => { if (t >= s.A && t <= s.B && (best < 0 || s.B - s.A < st.secs[best].B - st.secs[best].A)) best = i; });
    return best;
  }
  function barTime(d, x) { const r = d.el.getBoundingClientRect(); return d.lo + clamp((x - r.left) / r.width, 0, 1) * (d.hi - d.lo); }
  function onDown(name, e) {
    if (!video || !dur() || (e.button != null && e.button > 0)) return;
    const elb = $('#' + name), [lo, hi] = winOf(name), r = elb.getBoundingClientRect();
    const d = { bar: name, el: elb, lo, hi, mode: 'new', x0: e.clientX, moved: false, id: e.pointerId };
    d.anchor = barTime(d, e.clientX);
    const px = t => r.left + (t - lo) / (hi - lo) * r.width;
    const dA = st.A != null ? Math.abs(e.clientX - px(st.A)) : 1e9;
    const dB = st.B != null && st.A != null && st.B > st.A ? Math.abs(e.clientX - px(st.B)) : 1e9;
    if (name === 'full') d.mode = 'scrub'; // whole-song bar only moves the playhead
    else if (Math.min(dA, dB) < 20) d.mode = dA <= dB ? 'A' : 'B';
    drag = d;
    try { elb.setPointerCapture(e.pointerId); } catch (er) {}
    e.preventDefault();
  }
  function onMove(e) {
    const d = drag; if (!d || e.pointerId !== d.id) return;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 5) return;
    d.moved = true;
    const t = barTime(d, e.clientX), D = dur();
    if (d.mode === 'scrub') { d.lastT = t; seek(t); renderBars(); return; }
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
    if (d.mode === 'scrub') {
      const t = d.moved && d.lastT != null ? d.lastT : d.anchor;
      const i = d.moved ? -1 : savedAt(t);
      if (i >= 0 && i !== st.cur) { useSection(i); return; }
      seek(t); lastLoop = performance.now();
      // moving outside the A-B range: stop looping so the jump isn't undone
      if (loopActive() && (t < st.A - 0.05 || t > st.B)) { st.loopOn = false; save(); toast('구간 밖으로 이동 · 반복 꺼짐 (A·B를 다시 찍거나 ⋯에서 반복 켜기)'); }
    }
    else if (!d.moved) { seek(d.anchor); lastLoop = performance.now(); }
    else {
      if (d.mode === 'new') st.loopOn = true;
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
  // ---------- YouTube playlist (shown beside the video on wide screens, over it on phones) ----------
  let plOpen = null, plItems = [], plKey = '', lastPR = -1, plRead = 0;
  const hasList = () => { try { return new URL(location.href).searchParams.has('list'); } catch (e) { return false; } };
  const plVisible = () => cfg.open && !!st.id && hasList() && (plOpen == null ? innerWidth >= 900 : plOpen);
  function readPlaylist() {
    return [...document.querySelectorAll('ytd-playlist-panel-renderer ytd-playlist-panel-video-renderer, ytm-playlist-panel-video-renderer')].map(e => {
      const a = e.querySelector('a[href*="watch"]'), href = (a && a.getAttribute('href')) || '', m = href.match(/[?&]v=([\w-]{11})/);
      const te = e.querySelector('#video-title') || e.querySelector('h3, h4, [class*="Headline"], [class*="title"]');
      const by = e.querySelector('#byline, [class*="Subhead"], [class*="byline"]');
      return { id: m && m[1], t: te ? te.textContent.trim() : '', by: by ? by.textContent.trim() : '', a };
    }).filter((x, i, arr) => x.id && arr.findIndex(y => y.id === x.id) === i);
  }
  function renderPlaylist(force) {
    const show = plVisible();
    $('#plp').hidden = !show;
    $('#plBtn').hidden = !(cfg.open && st.id && hasList());
    $('#plBtn').classList.toggle('on', show);
    const r = show && innerWidth >= 900 ? Math.min(360, Math.round(innerWidth * 0.86)) : 0;
    if (r !== lastPR) { lastPR = r; document.documentElement.style.setProperty('--pp-r', r + 'px'); if (fullOn) window.dispatchEvent(new Event('resize')); }
    if (!show) return;
    const now = performance.now();
    if (!force && now - plRead < 700) return;
    plRead = now;
    plItems = readPlaylist();
    const key = st.id + '|' + plItems.map(x => x.id + x.t).join(',');
    if (key === plKey && !force) return;
    plKey = key;
    const head = document.querySelector('ytd-playlist-panel-renderer .title, .playlist-engagement-panel-mix-title, .playlist-panel-list-title, h2.playlist-engagement-panel-header');
    $('#plT').textContent = (head && head.textContent.trim()) || '재생목록';
    const box = $('#plList'); box.textContent = '';
    if (!plItems.length) box.appendChild(el('div', 'empty', '재생목록을 불러오는 중이에요. 잠시 뒤에도 비어 있으면 ✕로 연습 화면을 닫고 유튜브 화면에서 재생목록을 한 번 펼쳐 주세요.'));
    let cur = null;
    plItems.forEach((x, i) => {
      const it = el('div', 'it' + (x.id === st.id ? ' on' : ''));
      const go = el('button', 'go'); go.appendChild(el('b', '', (i + 1) + '. ' + (x.t || x.id)));
      if (x.by) go.appendChild(el('small', '', x.by));
      go.addEventListener('click', () => {
        if (innerWidth < 900) plOpen = false;
        if (x.a) x.a.click(); else location.href = location.origin + '/watch?v=' + x.id;
        renderPlaylist(true);
      });
      it.appendChild(go); box.appendChild(it);
      if (x.id === st.id) cur = it;
    });
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
  $('#plBtn').addEventListener('click', () => { plOpen = !plVisible(); renderPlaylist(true); });
  $('#plX').addEventListener('click', () => { plOpen = false; renderPlaylist(true); });

  // ---------- wiring ----------
  $$('[data-r]').forEach(b => b.addEventListener('click', () => setRate(st.rate + parseInt(b.dataset.r, 10))));
  $('#r100').addEventListener('click', () => setRate(100));
  $('#loop').addEventListener('click', toggleLoop);
  $('#add').addEventListener('click', addSection);
  $('#add2').addEventListener('click', addSection);
  function clearRange() { newRange(); st.A = st.B = null; markStage = 0; save(); renderLists(); ui(); toast('A·B 구간을 지웠어요 (저장한 구간은 그대로)'); }
  $('#clear').addEventListener('click', clearRange);
  $('#clr').addEventListener('click', clearRange);
  $('#back').addEventListener('click', () => goA(true));
  $('#play').addEventListener('click', togglePlay);
  $('#mk').addEventListener('click', mark);
  const showPanel = p => { panel = panel === p ? '' : p; sheetOpen = true; if (panel === 'lib') { libTab = 'song'; renderLists(); } ui(); };
  $('#gear').addEventListener('click', () => showPanel('set'));
  $('#libBtn').addEventListener('click', () => showPanel('lib'));
  $('#more').addEventListener('click', () => { sheetOpen = !sheetOpen; if (!sheetOpen) panel = ''; ui(); });
  $$('.tabs button').forEach(b => b.addEventListener('click', async () => { libTab = b.dataset.tab; if (libTab === 'all') lib = await store.get('pp:lib', {}); renderLists(); }));
  $('#min').addEventListener('click', () => { cfg.open = false; sheetOpen = false; panel = ''; saveCfg(); ui(); });
  $('#fab').addEventListener('click', () => { cfg.open = true; saveCfg(); ui(); });
  $('#fs').addEventListener('click', () => {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => toast('전체 화면을 쓸 수 없어요'));
    } catch (e) { toast('전체 화면을 쓸 수 없어요'); }
  });
  document.addEventListener('fullscreenchange', () => { setTimeout(() => window.dispatchEvent(new Event('resize')), 100); ui(); });
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
  const segs = { gapSeg: 'gap', latSeg: 'lat' };
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
    '[': 'A', ']': 'B', ArrowUp: 'up', ArrowDown: 'down', '+': 'up', '=': 'up', '-': 'down', '_': 'down', Delete: 'clear' };
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
      case 'A': setA(); break;
      case 'clear': clearRange(); break;
      case 'B': setB(); break;
      case 'up': setRate(st.rate + 5); toast('속도 ' + st.rate + '%'); break;
      case 'down': setRate(st.rate - 5); toast('속도 ' + st.rate + '%'); break;
    }
  }, true);

  // ---------- render ----------
  function ui() {
    const onWatch = !!st.id;
    host.style.display = onWatch ? '' : 'none';
    setFull(cfg.open && onWatch);
    $('#wrap').hidden = !cfg.open;
    $('#fab').hidden = cfg.open;
    $('#sheet').hidden = !sheetOpen;
    $('#more').classList.toggle('on', sheetOpen);
    $('#set').hidden = panel !== 'set';
    $('#lib').hidden = panel !== 'lib';
    $('#gear').classList.toggle('on', panel === 'set');
    $('#libBtn').classList.toggle('on', panel === 'lib');
    $('#fs').classList.toggle('on', !!document.fullscreenElement);
    const cs = st.secs[st.cur];
    $('#libBtn').textContent = '📁 ' + (cs ? cs.n : '구간') + (st.secs.length ? ' ' + st.secs.length : '');
    const playing = video && !video.paused;
    const pp = $('#play');
    pp.textContent = inGap ? String(gapLeft) : (playing ? '❚❚' : '▶');
    pp.classList.toggle('on', !!playing && !inGap);
    const waitB = markStage === 1 && st.A != null;
    $('#mk').classList.toggle('wait', waitB);
    $('#mkT').textContent = waitB ? 'B' : 'A·B';
    $('#mk').title = waitB ? 'B 찍기 (A ' + fmt(st.A) + ')' : 'A·B 찍기';
    $('#add').textContent = cs ? '✓ ' + cs.n : '＋ 저장';
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
    layout();
  }
  // Keep the player's height in step with our bar (the sheet floats over the video and doesn't count).
  let lastPH = -1;
  function layout() {
    const w = $('#wrap'), barH = cfg.open ? (w.offsetHeight || 0) : 0;
    const sh = sheetOpen && cfg.open ? ($('#sheet').offsetHeight || 0) : 0;
    root.host.style.setProperty('--h', (barH + sh) + 'px');
    root.host.style.setProperty('--bh', barH + 'px');
    if (barH !== lastPH) { lastPH = barH; document.documentElement.style.setProperty('--pp-h', barH + 'px'); if (fullOn) window.dispatchEvent(new Event('resize')); }
  }
  function info() {
    const e = $('#info');
    if (!video) { e.textContent = '영상을 찾는 중…'; return; }
    const ad = adShowing() ? ' · 광고 중' : '';
    e.textContent = fmt(video.currentTime) + (loopActive() ? ' · ' + st.loops + '회 반복' : '') + (tr.on ? ' · 자동↑' : '') + ad;
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
    if (now - lastInfo > 100) { lastInfo = now; info(); renderBars(); renderYT(); setFull(cfg.open && !!st.id); layout(); renderPlaylist(); }
    if (!tick.busy) { tick.busy = true; requestAnimationFrame(() => { tick.busy = false; tick(); }); }
  }

  (async () => {
    Object.assign(cfg, await store.get('pp:cfg', {}));
    lib = await store.get('pp:lib', {});
    document.documentElement.appendChild(host);
    ui();
    setInterval(tick, 100); tick();
  })();
})();
