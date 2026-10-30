(() => {
'use strict';

const $ = id => document.getElementById(id);
const ORIGIN = performance.timeOrigin;            // local epoch of performance.now() == 0
const API = 'https://timeapi.io/api/time/current/zone?timeZone=UTC';
const API_COORD = 'https://timeapi.io/api/time/current/coordinate';

/* ---------- i18n ---------- */
let lang = localStorage.getItem('lang') ||
  ({ ko: 'ko', ja: 'ja', zh: 'zh' })[(navigator.language || 'en').slice(0, 2)] || 'en';
const t = k => (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k;
function applyLang() {
  document.documentElement.lang = lang;
  document.title = t('title');
  document.querySelectorAll('[data-lang]').forEach(b => {
    const on = b.dataset.lang === lang;
    b.setAttribute('aria-selected', on);
    if (on) $('lang-cur').textContent = b.textContent;
  });
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  swSync(); tmSync(); renderStatus(); renderLoc();
}
const langMenu = $('lang-menu'), langBtn = $('lang-btn');
const setMenu = open => { langMenu.hidden = !open; langBtn.setAttribute('aria-expanded', open); };
langBtn.addEventListener('click', e => { e.stopPropagation(); setMenu(langMenu.hidden); });
document.addEventListener('click', () => setMenu(false));
langMenu.querySelectorAll('[data-lang]').forEach(li => li.addEventListener('click', () => {
  lang = li.dataset.lang; localStorage.setItem('lang', lang); setMenu(false); applyLang();
}));

/* ---------- time base ----------
   Everything runs on performance.now() (monotonic, sub-ms). `offset` = true UTC - (ORIGIN + performance.now()). */
let offset = 0, uncertainty = Infinity, synced = false, nSamples = 0, srcNames = [];
const trueNow = () => ORIGIN + performance.now() + offset;

/* ---------- synchronisation ----------
   Every sample yields a *rigorous interval* [lo, hi] that must contain the offset
   (the server stamped its time somewhere between our send and receive). Intervals from
   many samples/sources are intersected, so the uncertainty only ever shrinks. */
const overlap = (a, b) => { const lo = Math.max(a[0], b[0]), hi = Math.min(a[1], b[1]); return lo <= hi ? [lo, hi] : null; };
function addIv(cur, iv) {
  if (!cur) return iv;
  return overlap(cur, iv) || (iv[1] - iv[0] < cur[1] - cur[0] ? iv : cur);
}
const wait = ms => new Promise(r => setTimeout(r, ms));

function parseUtc(s) {                              // "2026-10-30T10:25:57.7114458" (UTC)
  const m = s.split('.');
  return Date.parse(m[0] + 'Z') + (m[1] ? Number('0.' + m[1]) * 1000 : 0);
}
async function apiSample() {
  const t0 = performance.now();
  const r = await fetch(API, { cache: 'no-store' });
  const t1 = performance.now();
  const j = await r.json();
  const s = parseUtc(j.dateTime);
  return [s - (ORIGIN + t1), s - (ORIGIN + t0)];
}
// Same-origin Date header (1 s resolution). Request is timed so the server stamp lands on a second boundary,
// which makes the "rolled over / not rolled over" answer bisect the offset.
async function headerSample(prior, rtt) {
  let L = null;
  if (prior != null) {
    const k = Math.ceil((ORIGIN + performance.now() + prior + rtt + 60) / 1000) * 1000;
    L = k - prior - rtt / 2 - ORIGIN;
    await wait(Math.max(0, L - performance.now() - 4));
    while (performance.now() < L) { /* spin for exact send time */ }
  }
  const t0 = performance.now();
  const r = await fetch(location.pathname + '?_=' + Math.random(), { method: 'HEAD', cache: 'no-store' });
  const t1 = performance.now();
  const d = r.headers.get('date');
  if (!d) return null;
  const S = Date.parse(d);
  const iv = [S - (ORIGIN + t1), S + 1000 - (ORIGIN + t0)];
  // CDNs may replay a cached Date; reject anything far from the current estimate
  if (prior != null && Math.abs((iv[0] + iv[1]) / 2 - prior) > 1500) return null;
  iv.rtt = t1 - t0;
  return iv;
}

let syncing = false;
async function sync() {
  if (syncing) return; syncing = true; renderStatus();
  let api = null, hdr = null, n = 0, hdrRtt = 40;
  const combined = () => {
    if (api && hdr) { const o = overlap(api, hdr); return o || (api[1] - api[0] < hdr[1] - hdr[0] ? api : hdr); }
    return api || hdr;
  };
  const apply = () => {
    const iv = combined(); if (!iv) return;
    offset = (iv[0] + iv[1]) / 2; uncertainty = (iv[1] - iv[0]) / 2; synced = true; nSamples = n;
    srcNames = [api && 'timeapi.io', hdr && 'HTTP Date'].filter(Boolean);
    renderStatus();
  };
  const sameOrigin = /^https?:$/.test(location.protocol);
  const apiLoop = async () => {
    for (let i = 0; i < 10; i++) {
      try {
        const iv = await apiSample();
        api = addIv(api, iv); n++; apply();
      } catch (e) { /* source unavailable */ }
      await wait(60);
    }
  };
  const hdrLoop = async () => {
    if (!sameOrigin) return;
    for (let i = 0; i < 14; i++) {
      try {
        while (!api && i === 0) await wait(50);      // wait for a first estimate to aim at
        const m = x => (x[0] + x[1]) / 2;
        const aim = hdr ? m(api && overlap(api, hdr) || hdr) : offset;
        const iv = await headerSample(aim, hdrRtt);
        if (iv) { hdrRtt = i ? Math.min(hdrRtt, iv.rtt) : iv.rtt; hdr = addIv(hdr, iv); n++; apply(); }
      } catch (e) { /* ignore */ }
    }
  };
  await Promise.all([apiLoop(), hdrLoop()]);
  syncing = false; renderStatus();
}

/* ---------- time zone / GPS ---------- */
let tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
let tzSource = 'deviceTz', loc = null, gpsState = '';
let fmtTime, fmtDate, fmtZone;
function buildFormatters() {
  const o = { timeZone: tz };
  fmtTime = new Intl.DateTimeFormat('en-GB', { ...o, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  fmtDate = new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : lang, { ...o, dateStyle: 'full' });
  fmtZone = new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : lang, { ...o, timeZoneName: 'longOffset' });
  curSec = -1;
}
function locateGps() {
  if (!navigator.geolocation) { gpsState = 'gpsDenied'; renderLoc(); return; }
  gpsState = 'gpsWait'; renderLoc();
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude, longitude, accuracy } = pos.coords;
    loc = { latitude, longitude, accuracy };
    try {
      const r = await fetch(`${API_COORD}?latitude=${latitude}&longitude=${longitude}`);
      const j = await r.json();
      if (j.timeZone) { tz = j.timeZone; tzSource = 'gpsTz'; buildFormatters(); }
    } catch (e) { /* keep device time zone */ }
    gpsState = ''; renderLoc();
  }, () => { gpsState = 'gpsDenied'; renderLoc(); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}
$('gps').addEventListener('click', locateGps);
function renderLoc() {
  buildFormatters();
  $('clock-tz').textContent = `${tz} · ${t(tzSource)}`;
  $('clock-loc').textContent = gpsState ? t(gpsState)
    : loc ? `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)} (${t('accuracy')} ±${Math.round(loc.accuracy)} m)` : '';
}
function renderStatus() {
  const el = $('sync-status');
  if (!synced) { el.className = 'status bad'; el.innerHTML = syncing ? t('syncing') : `<b>${t('offline')}</b>`; return; }
  el.className = 'status ok';
  const u = uncertainty < 1 ? uncertainty.toFixed(2) : uncertainty.toFixed(1);
  el.innerHTML = `<b>${t('synced')}</b> · ${t('uncertainty')} ±${u} ms<br>` +
    `${t('offsetLbl')}: ${offset >= 0 ? '+' : ''}${offset.toFixed(1)} ms · ${nSamples} ${t('samples')} · ${srcNames.join(' + ')}` +
    (syncing ? ` · ${t('syncing')}` : '');
}

/* ---------- formatting ---------- */
const p2 = n => (n < 10 ? '0' : '') + n;
const p3 = n => (n < 10 ? '00' : n < 100 ? '0' : '') + n;
function fmtDur(ms) {
  const x = Math.floor(ms < 0 ? 0 : ms);
  return `${p2(Math.floor(x / 3600000))}:${p2(Math.floor(x / 60000) % 60)}:${p2(Math.floor(x / 1000) % 60)}.${p3(x % 1000)}`;
}

/* ---------- clock ---------- */
let curSec = -1, secText = '';
const elClock = $('clock-time');
function renderClock() {
  const tn = trueNow(), s = Math.floor(tn / 1000);
  if (s !== curSec) {                               // heavy Intl work only once per second
    curSec = s;
    secText = fmtTime.format(s * 1000) + '.';
    $('clock-date').textContent = fmtDate.format(s * 1000);
    if (s % 60 === 0 || !$('clock-tz').dataset.off) {
      const z = fmtZone.formatToParts(s * 1000).find(p => p.type === 'timeZoneName');
      $('clock-tz').dataset.off = '1';
      $('clock-tz').textContent = `${tz} (${z ? z.value : ''}) · ${t(tzSource)}`;
    }
  }
  elClock.textContent = secText + p3(Math.floor(tn - s * 1000));
}

/* ---------- input helper: act on the *press*, timestamped by the event itself ---------- */
function bindPress(el, fn) {
  el.addEventListener('pointerdown', e => { if (e.button === 0) { e.preventDefault(); select(el.closest('.panel')); fn(e.timeStamp); } });
  el.addEventListener('click', e => { if (e.detail === 0) fn(e.timeStamp); });   // keyboard activation only
}
const panels = { sw: $('p-sw'), tm: $('p-tm'), clock: $('p-clock') };
let active = 'sw';
function select(p) {
  for (const k in panels) { panels[k].classList.toggle('active', panels[k] === p); if (panels[k] === p) active = k; }
}
Object.values(panels).forEach(p => p.addEventListener('pointerdown', () => select(p)));

/* ---------- one view at a time (clock / stopwatch / timer) ---------- */
const ORDER = ['clock', 'sw', 'tm'];
let view = null;
function showView(k) {
  view = k;
  ORDER.forEach(n => panels[n].classList.toggle('view', n === k));
  select(panels[k]);
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-selected', b.dataset.view === k));
  curSec = -1;                                      // refresh clock texts
}
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
$('full-toggle').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
});

/* ---------- stopwatch ---------- */
const sw = { running: false, t0: 0, acc: 0, laps: [] };
const swEl = $('sw-time');
const swElapsed = ts => sw.acc + (sw.running ? ts - sw.t0 : 0);
function swToggle(ts) {
  if (sw.running) { sw.acc += ts - sw.t0; sw.running = false; swEl.textContent = fmtDur(sw.acc); }
  else { sw.t0 = ts; sw.running = true; }
  swSync();
}
function swLap(ts) {
  if (!sw.running) return;
  const cur = swElapsed(ts), prev = sw.laps.length ? sw.laps[sw.laps.length - 1].total : 0;
  sw.laps.push({ total: cur, split: cur - prev });
  const li = document.createElement('li');
  li.innerHTML = `<span>${fmtDur(cur - prev)}</span> &nbsp; ${fmtDur(cur)}`;
  $('sw-laps').prepend(li);
}
function swReset() {
  if (sw.running) return;
  sw.acc = 0; sw.laps = []; $('sw-laps').innerHTML = ''; swEl.textContent = fmtDur(0);
}
function swSync() {
  const b = $('sw-toggle'); b.textContent = t(sw.running ? 'stop' : 'start'); b.classList.toggle('running', sw.running);
}
bindPress($('sw-toggle'), swToggle);
bindPress($('sw-lap'), swLap);
bindPress($('sw-reset'), swReset);

/* ---------- timer ---------- */
const tm = { running: false, t0: 0, remaining: 0, nodes: [] };
const tmEl = $('tm-time');
let audio = null;
const tmInput = () => ((+$('tm-h').value || 0) * 3600 + (+$('tm-m').value || 0) * 60 + (+$('tm-s').value || 0)) * 1000;
const tmRemaining = ts => tm.remaining - (tm.running ? ts - tm.t0 : 0);
function scheduleAlarm(inMs) {                      // sample-accurate beeps on the audio clock
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    audio.resume();
    const at = audio.currentTime + Math.max(0, inMs) / 1000;
    tm.nodes = [0, 0.3, 0.6, 0.9, 1.2].map(d => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = 1000; o.connect(g); g.connect(audio.destination);
      g.gain.setValueAtTime(0.0001, at + d); g.gain.linearRampToValueAtTime(0.4, at + d + 0.005);
      g.gain.setValueAtTime(0.4, at + d + 0.15); g.gain.linearRampToValueAtTime(0.0001, at + d + 0.17);
      o.start(at + d); o.stop(at + d + 0.2); return o;
    });
  } catch (e) { /* audio unavailable */ }
}
function cancelAlarm() { tm.nodes.forEach(o => { try { o.stop(); o.disconnect(); } catch (e) {} }); tm.nodes = []; }
function tmToggle(ts) {
  if (tm.running) { tm.remaining -= ts - tm.t0; tm.running = false; cancelAlarm(); tmEl.textContent = fmtDur(tm.remaining); }
  else {
    if (tm.remaining <= 0) tm.remaining = tmInput();
    if (tm.remaining <= 0) return;
    tm.t0 = ts; tm.running = true; scheduleAlarm(tm.remaining - (performance.now() - ts));
  }
  tmEl.parentElement.classList.remove('flash'); tmSync();
}
function tmReset() {
  if (tm.running) return;
  cancelAlarm(); tm.remaining = tmInput(); tmEl.textContent = fmtDur(tm.remaining); tmEl.parentElement.classList.remove('flash');
}
function tmSync() {
  const b = $('tm-toggle'); b.textContent = t(tm.running ? 'stop' : 'start'); b.classList.toggle('running', tm.running);
}
['tm-h', 'tm-m', 'tm-s'].forEach(id => $(id).addEventListener('input', () => { if (!tm.running) tmReset(); }));
bindPress($('tm-toggle'), tmToggle);
bindPress($('tm-reset'), tmReset);
tm.remaining = tmInput();

/* ---------- keyboard: Space acts on keydown (not keyup / click) ---------- */
const typing = e => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
addEventListener('keydown', e => {
  if (typing(e) || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  {
    const i = ORDER.indexOf(view);
    if (e.code === 'ArrowRight') { showView(ORDER[(i + 1) % 3]); return; }
    if (e.code === 'ArrowLeft') { showView(ORDER[(i + 2) % 3]); return; }
    if (/^Digit[1-3]$/.test(e.code)) { showView(ORDER[+e.code[5] - 1]); return; }
  }
  if (e.code === 'Space') {
    e.preventDefault();
    if (active === 'sw') swToggle(e.timeStamp); else if (active === 'tm') tmToggle(e.timeStamp);
  } else if (e.code === 'KeyL' && active === 'sw') swLap(e.timeStamp);
  else if (e.code === 'KeyR') { if (active === 'sw') swReset(); else if (active === 'tm') tmReset(); }
});
addEventListener('keyup', e => { if (e.code === 'Space' && !typing(e)) e.preventDefault(); });

/* ---------- render loop ---------- */
function frame() {
  const now = performance.now();
  renderClock();
  if (sw.running) swEl.textContent = fmtDur(swElapsed(now));
  if (tm.running) {
    const r = tmRemaining(now);
    if (r <= 0) {
      tm.running = false; tm.remaining = 0; tmEl.textContent = fmtDur(0);
      tmEl.parentElement.classList.add('flash'); tmSync();
    } else tmEl.textContent = fmtDur(r);
  }
  requestAnimationFrame(frame);
}

/* ---------- start ---------- */
applyLang();
showView('clock');
sync();
setInterval(sync, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
locateGps();
requestAnimationFrame(frame);
})();
