import * as db from './db.js';
import { getSettings, saveSettings } from './settings.js';
import { GeoTracker } from './geo.js';
import { Camera, resizeToJpeg } from './camera.js';
import { injectGps } from './exif.js';
import { exportProject, photoFilename } from './export.js';
import { Compass } from './compass.js';
import { distance, bearing, cardinal } from './geomath.js';

const $ = (sel) => document.querySelector(sel);
const geo = new GeoTracker();
const camera = new Camera($('#viewfinder'));
const compass = new Compass();

let currentProject = null;
let objectUrls = [];
let wakeLock = null;

// ---------- helpers ----------

function toast(msg, ms = 2500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

function trackUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return url;
}

function revokeUrls() {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Promise-based prompt/confirm built on <dialog>. Resolves to string (prompt), true (confirm) or null. */
function ask({ title, message = '', value = null, ok = 'OK' }) {
  const dlg = $('#dlg-prompt');
  $('#prompt-title').textContent = title;
  $('#prompt-message').textContent = message;
  $('#prompt-ok').textContent = ok;
  const input = $('#prompt-input');
  input.hidden = value === null;
  input.required = value !== null;
  input.value = value ?? '';
  dlg.returnValue = '';
  dlg.showModal();
  if (value !== null) input.select();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'ok') resolve(null);
      else resolve(value === null ? true : input.value.trim());
    }, { once: true });
  });
}

const fmtAcc = (m) => (m < 10 ? m.toFixed(1) : Math.round(m)) + ' m';
const fmtDate = (t) => new Date(t).toLocaleString();
const fmtDist = (m) => (m < 100 ? m.toFixed(1) + ' m' : m < 10000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km');
const fmtDir = (h, ref) => `${Math.round(h)}° ${cardinal(h)}${ref === 'M' ? ' (magnetic)' : ref === 'T' ? ' (true)' : ''}`;

/** Camera direction at this instant: compass if live, else GPS course when moving. */
function currentDirection(fix) {
  const h = compass.current();
  if (h !== null) return { heading: h, headingRef: 'M', headingSource: 'compass' };
  if (fix && Number.isFinite(fix.heading)) return { heading: fix.heading, headingRef: 'T', headingSource: 'gps-course' };
  return { heading: null, headingRef: null, headingSource: null };
}

// ---------- routing ----------

const views = ['projects', 'project', 'camera'];

function show(view, title, backHref = null) {
  views.forEach((v) => { $(`#view-${v}`).hidden = v !== view; });
  $('#topbar').hidden = view === 'camera';
  $('#title').textContent = title;
  $('#back').hidden = !backHref;
  $('#back').onclick = () => { location.hash = backHref; };
}

async function route() {
  revokeUrls();
  const [, kind, id, sub] = location.hash.split('/');
  if (sub !== 'camera') leaveCamera();
  try {
    if (kind === 'p' && id) {
      currentProject = await db.getProject(id);
      if (!currentProject) { location.hash = '#/'; return; }
      saveSettings({ lastProjectId: id });
      if (sub === 'camera') return enterCamera();
      return renderProject();
    }
    currentProject = null;
    return renderProjects();
  } catch (err) {
    console.error(err);
    toast(err.message);
  }
}

// ---------- projects list ----------

async function renderProjects() {
  show('projects', 'GeoSpotting Camera');
  const projects = await db.listProjects();
  $('#projects-empty').hidden = projects.length > 0;
  $('#project-list').innerHTML = projects.map((p) => `
    <li><a href="#/p/${p.id}">
      <span class="name">${esc(p.name)}</span>
      <span class="count">${p.photoCount} photo${p.photoCount === 1 ? '' : 's'}</span>
    </a></li>`).join('');
}

$('#new-project').addEventListener('click', async () => {
  compass.start();
  const name = await ask({ title: 'New project', value: `Project ${new Date().toLocaleDateString()}`, ok: 'Create' });
  if (!name) return;
  const p = await db.createProject(name);
  location.hash = `#/p/${p.id}/camera`;
});

// ---------- project view ----------

async function renderProject() {
  const p = currentProject;
  show('project', p.name, '#/');
  const photos = await db.listPhotos(p.id);
  const { accuracy } = getSettings();
  $('#photos-empty').hidden = photos.length > 0;
  $('#go-export').disabled = photos.length === 0;
  $('#project-meta').textContent = `${photos.length} photo${photos.length === 1 ? '' : 's'} · created ${fmtDate(p.createdAt)}`;
  const grid = $('#photo-grid');
  grid.innerHTML = '';
  for (const ph of photos) {
    const li = document.createElement('li');
    const coarse = ph.accuracy > accuracy;
    li.innerHTML = `<img loading="lazy" alt="Photo ${ph.seq}"><span class="badge ${coarse ? 'coarse' : ''}">±${fmtAcc(ph.accuracy)}</span>`;
    li.querySelector('img').src = trackUrl(ph.thumb);
    li.addEventListener('click', () => { compass.start(); openPhoto(ph.id); });
    grid.append(li);
  }
}

$('#go-camera').addEventListener('click', () => { compass.start(); location.hash = `#/p/${currentProject.id}/camera`; });

$('#rename-project').addEventListener('click', async () => {
  const name = await ask({ title: 'Rename project', value: currentProject.name, ok: 'Rename' });
  if (!name) return;
  currentProject.name = name;
  await db.updateProject(currentProject);
  renderProject();
});

$('#delete-project').addEventListener('click', async () => {
  const ok = await ask({ title: 'Delete project?', message: `"${currentProject.name}" and all its photos will be permanently removed from this device.`, ok: 'Delete' });
  if (!ok) return;
  await db.deleteProject(currentProject.id);
  location.hash = '#/';
});

let livePhoto = null; // photo shown in the detail dialog, for live distance updates

function renderPhotoInfo(ph) {
  const rows = [
    ['File', photoFilename(currentProject, ph)],
    ['Latitude', ph.lat.toFixed(8)],
    ['Longitude', ph.lon.toFixed(8)],
    ['Accuracy', `±${ph.accuracy.toFixed(2)} m`],
    ['Altitude', Number.isFinite(ph.altitude) ? `${ph.altitude.toFixed(1)} m` + (Number.isFinite(ph.altitudeAccuracy) ? ` (±${ph.altitudeAccuracy.toFixed(1)} m)` : '') : '—'],
    ['Direction', Number.isFinite(ph.heading) ? fmtDir(ph.heading, ph.headingRef) : '—'],
    ['Taken', fmtDate(ph.takenAt)],
    ph.locationUpdatedAt
      ? ['Location set', `${fmtDate(ph.locationUpdatedAt)} (moved ${fmtDist(distance(ph.originalLocation.lat, ph.originalLocation.lon, ph.lat, ph.lon))} from original)`]
      : ['Fix offset', `${((ph.fixTime - ph.takenAt) / 1000).toFixed(1)} s vs. shutter`],
    ['Size', `${ph.width} × ${ph.height}`],
  ];
  $('#photo-info').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
  $('#photo-map').href = `https://www.openstreetmap.org/?mlat=${ph.lat}&mlon=${ph.lon}#map=19/${ph.lat}/${ph.lon}`;
}

function renderLiveDistance() {
  const ph = livePhoto;
  if (!ph) return;
  const { state, fix } = geo.evaluate(getSettings());
  const panel = $('#photo-live');
  panel.dataset.state = state;
  const arrow = $('#live-arrow');
  if (!fix) {
    $('#live-distance').textContent = geo.error ? 'No GPS' : 'Waiting for GPS…';
    $('#live-detail').textContent = geo.error?.message ?? '';
    arrow.hidden = true;
    return;
  }
  const d = distance(fix.lat, fix.lon, ph.lat, ph.lon);
  const b = bearing(fix.lat, fix.lon, ph.lat, ph.lon);
  const sigma = Math.hypot(fix.accuracy, ph.accuracy);
  $('#live-distance').textContent = `${fmtDist(d)} away` + (d > 0.05 ? ` · ${cardinal(b)} ${Math.round(b)}°` : '');
  $('#live-detail').textContent = `You ±${fmtAcc(fix.accuracy)} · photo ±${fmtAcc(ph.accuracy)}` +
    (d <= sigma ? ' · within combined uncertainty' : '') + (geo.age() >= 2 ? ` · fix ${Math.round(geo.age())}s old` : '');
  // Arrow points at the photo location: relative to where the phone points if the compass is live, else north-up.
  const h = compass.current();
  arrow.hidden = d < 0.05;
  arrow.style.transform = `rotate(${b - (h ?? 0)}deg)`;
  arrow.title = h === null ? 'North-up (no compass)' : 'Relative to where the phone points';
  arrow.classList.toggle('north-up', h === null);
}

async function openPhoto(id) {
  const ph = await db.getPhoto(id);
  const dlg = $('#dlg-photo');
  const url = URL.createObjectURL(ph.blob);
  $('#photo-full').src = url;
  livePhoto = ph;
  renderPhotoInfo(ph);
  geo.start();
  renderLiveDistance();
  const timer = setInterval(renderLiveDistance, 1000);
  $('#photo-relocate').onclick = () => relocatePhoto(ph);
  $('#photo-delete').onclick = async () => {
    dlg.close();
    if (!(await ask({ title: 'Delete photo?', ok: 'Delete' }))) return;
    await db.deletePhoto(ph.id);
    revokeUrls();
    renderProject();
  };
  dlg.addEventListener('close', () => {
    URL.revokeObjectURL(url);
    clearInterval(timer);
    livePhoto = null;
    if ($('#view-camera').hidden) geo.stop();
  }, { once: true });
  dlg.showModal();
}

/** Replace a photo's stored location with the current fix (re-tags the stored JPEG). */
async function relocatePhoto(ph) {
  const btn = $('#photo-relocate');
  btn.disabled = true;
  try {
    if (geo.age() > getSettings().maxFixAge) {
      $('#live-distance').textContent = 'Getting fresh GPS fix…';
      await geo.refresh();
    }
    const { state, fix } = geo.evaluate(getSettings());
    const accepted = await acceptFix(state, fix);
    if (!accepted) return;
    const moved = distance(ph.lat, ph.lon, accepted.lat, accepted.lon);
    const ok = await ask({
      title: 'Set location?',
      message: `Replace the saved location (±${fmtAcc(ph.accuracy)}) with your current position (±${fmtAcc(accepted.accuracy)}), ${fmtDist(moved)} away.`,
      ok: 'Set location',
    });
    if (!ok) return;
    ph.originalLocation ??= { lat: ph.lat, lon: ph.lon, accuracy: ph.accuracy, altitude: ph.altitude, fixTime: ph.fixTime };
    Object.assign(ph, {
      lat: accepted.lat, lon: accepted.lon, accuracy: accepted.accuracy,
      altitude: accepted.altitude, altitudeAccuracy: accepted.altitudeAccuracy,
      fixTime: accepted.fixTime, locationUpdatedAt: Date.now(),
    }); // heading is kept: it describes the photo, not where you stand now
    const bytes = injectGps(new Uint8Array(await ph.blob.arrayBuffer()), ph);
    ph.blob = new Blob([bytes], { type: 'image/jpeg' });
    await db.updatePhoto(ph);
    renderPhotoInfo(ph);
    renderLiveDistance();
    toast(`Location updated · ±${fmtAcc(ph.accuracy)}`);
    renderProject(); // refresh accuracy badges behind the dialog
  } catch (e) {
    console.error(e);
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- camera ----------

function renderGps() {
  const s = getSettings();
  const { state, fix } = geo.evaluate(s);
  const pill = $('#gps-pill');
  pill.dataset.state = state;
  $('#shutter').dataset.state = state;
  if (geo.error && !fix) {
    $('#gps-text').textContent = geo.error.code === 1 ? 'Location permission denied' : `GPS: ${geo.error.message}`;
  } else if (!fix) {
    $('#gps-text').textContent = 'Waiting for GPS…';
  } else {
    const age = geo.age();
    $('#gps-text').textContent = `±${fmtAcc(fix.accuracy)} / ${s.accuracy} m` + (age >= 1 ? ` · ${Math.round(age)}s old` : '');
  }
  renderCompass();
}

function renderCompass() {
  const h = compass.current();
  const el = $('#compass-text');
  el.hidden = h === null && !compass.needsPermission;
  el.textContent = h === null ? 'Tap for compass' : `${Math.round(h)}° ${cardinal(h)}`;
}

let gpsTimer = null;

async function enterCamera() {
  show('camera', currentProject.name);
  geo.start();
  renderGps();
  clearInterval(gpsTimer);
  gpsTimer = setInterval(renderGps, 1000); // keep fix age current between updates
  await refreshLastThumb();
  await startCamera();
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not critical */ }
}

async function startCamera() {
  const err = $('#camera-error');
  err.hidden = true;
  $('#shutter').disabled = true;
  try {
    await camera.start({ resolution: getSettings().resolution });
    $('#shutter').disabled = false;
  } catch (e) {
    err.hidden = false;
    err.textContent = e.name === 'NotAllowedError'
      ? 'Camera permission denied. You can still use the system camera button (right).'
      : `Camera unavailable (${e.message}). You can still use the system camera button (right).`;
  }
}

function leaveCamera() {
  camera.stop();
  clearInterval(gpsTimer);
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

async function refreshLastThumb() {
  const photos = await db.listPhotos(currentProject.id);
  const last = photos.at(-1);
  const img = $('#last-thumb img');
  if (last) img.src = trackUrl(last.thumb); else img.removeAttribute('src');
  $('#shot-count').textContent = photos.length;
}

/** Decide whether the current fix may be used; may ask the user. Returns the fix or null. */
async function acceptFix(state, fix) {
  const s = getSettings();
  if (state === 'ok') return fix;
  if (!fix) { toast('No GPS fix yet — wait for the indicator.'); return null; }
  const reason = state === 'stale'
    ? `The last GPS fix is ${Math.round(geo.age())} s old (limit ${s.maxFixAge} s).`
    : `Accuracy is ±${fix.accuracy.toFixed(1)} m (target ${s.accuracy} m).`;
  if (!s.allowInaccurate) { toast(reason + ' Photo not saved.', 4000); return null; }
  return (await ask({ title: 'Save anyway?', message: reason, ok: 'Save' })) ? fix : null;
}

async function savePhoto(jpegBlob, fix, direction, takenAt, width, height) {
  const meta = { ...fix, ...direction, takenAt };
  const bytes = injectGps(new Uint8Array(await jpegBlob.arrayBuffer()), meta);
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  const { blob: thumb } = await resizeToJpeg(blob, { maxWidth: 320, maxHeight: 320, quality: 0.7 });
  await db.addPhoto(currentProject.id, { ...meta, blob, thumb, width, height });
  navigator.storage?.persist?.().catch(() => {});
  await refreshLastThumb();
  toast(`Saved · ±${fmtAcc(fix.accuracy)}`);
}

let busy = false;
$('#shutter').addEventListener('click', async () => {
  if (busy || !camera.active) return;
  busy = true;
  compass.start(); // no-op once running; on iOS the first tap grants permission
  try {
    // Snapshot both photo and position at the same instant; ask afterwards.
    let { state, fix } = geo.evaluate(getSettings());
    const takenAt = Date.now();
    const direction = currentDirection(fix);
    const jpeg = await camera.capture(getSettings().captureQuality);
    const flash = $('#flash');
    flash.classList.add('on');
    requestAnimationFrame(() => requestAnimationFrame(() => flash.classList.remove('on')));
    navigator.vibrate?.(30);
    if (state === 'stale' || state === 'none') {
      $('#gps-text').textContent = 'Getting fresh GPS fix…';
      await geo.refresh();
      ({ state, fix } = geo.evaluate(getSettings()));
    }
    const accepted = await acceptFix(state, fix);
    if (accepted) await savePhoto(jpeg, accepted, direction, takenAt, camera.video.videoWidth, camera.video.videoHeight);
  } catch (e) {
    console.error(e);
    toast(e.message);
  } finally {
    busy = false;
  }
});

$('#native-input').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    if (geo.age() > getSettings().maxFixAge) await geo.refresh();
    const { state, fix } = geo.evaluate(getSettings());
    const takenAt = file.lastModified || Date.now();
    // Re-encode to bake in EXIF orientation, then replace metadata with ours.
    const { blob, width, height } = await resizeToJpeg(file, { quality: getSettings().captureQuality });
    const accepted = await acceptFix(state, fix);
    // No direction: where the phone points now says nothing about where the system camera was aimed.
    const noDirection = { heading: null, headingRef: null, headingSource: null };
    if (accepted) await savePhoto(blob, accepted, noDirection, takenAt, width, height);
  } catch (e) {
    console.error(e);
    toast(e.message);
  }
});

$('#camera-back').addEventListener('click', () => { location.hash = `#/p/${currentProject.id}`; });
$('#camera-settings').addEventListener('click', () => $('#open-settings').click());
$('#last-thumb').addEventListener('click', () => { location.hash = `#/p/${currentProject.id}`; });
geo.addEventListener('change', () => {
  if (!$('#view-camera').hidden) renderGps();
  renderLiveDistance();
});
let compassFrame = 0;
compass.addEventListener('change', () => {
  if (compassFrame) return;
  compassFrame = requestAnimationFrame(() => {
    compassFrame = 0;
    if (!$('#view-camera').hidden) renderCompass();
    renderLiveDistance();
  });
});
$('#gps-pill').addEventListener('click', () => compass.start().then(renderCompass));

document.addEventListener('visibilitychange', async () => {
  if ($('#view-camera').hidden) return;
  if (document.hidden) { camera.stop(); }
  else {
    await startCamera();
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* ignore */ }
  }
});

// Close camera with Escape on desktop
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#view-camera').hidden && !document.querySelector('dialog[open]')) {
    location.hash = `#/p/${currentProject.id}`;
  }
  if ((e.key === ' ' || e.key === 'Enter') && !$('#view-camera').hidden && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    $('#shutter').click();
  }
});

// ---------- export ----------

let exported = null;

$('#go-export').addEventListener('click', () => {
  const s = getSettings();
  const form = $('#dlg-export form');
  form.maxWidth.value = s.exportMaxWidth || '';
  form.maxHeight.value = s.exportMaxHeight || '';
  form.quality.value = s.exportQuality;
  $('#export-progress').hidden = true;
  $('#export-status').textContent = '';
  $('#export-share').hidden = true;
  $('#export-run').disabled = false;
  exported = null;
  $('#dlg-export').showModal();
});

$('#export-run').addEventListener('click', async () => {
  const form = $('#dlg-export form');
  if (!form.reportValidity()) return;
  const opts = {
    maxWidth: Number(form.maxWidth.value) || 0,
    maxHeight: Number(form.maxHeight.value) || 0,
    quality: Number(form.quality.value),
  };
  saveSettings({ exportMaxWidth: opts.maxWidth, exportMaxHeight: opts.maxHeight, exportQuality: opts.quality });
  const progress = $('#export-progress');
  const status = $('#export-status');
  progress.hidden = false;
  $('#export-run').disabled = true;
  try {
    exported = await exportProject(currentProject, opts, (d, t) => {
      progress.max = t; progress.value = d;
      status.textContent = `Processing ${Math.min(d + 1, t)} / ${t}…`;
    });
    status.textContent = `${exported.filename} · ${(exported.blob.size / 1048576).toFixed(1)} MB`;
    download(exported);
    const file = new File([exported.blob], exported.filename, { type: 'application/zip' });
    $('#export-share').hidden = !navigator.canShare?.({ files: [file] });
  } catch (e) {
    console.error(e);
    status.textContent = `Export failed: ${e.message}`;
  } finally {
    $('#export-run').disabled = false;
  }
});

$('#export-share').addEventListener('click', async () => {
  if (!exported) return;
  const file = new File([exported.blob], exported.filename, { type: 'application/zip' });
  try { await navigator.share({ files: [file], title: exported.filename }); }
  catch (e) { if (e.name !== 'AbortError') toast(e.message); }
});

function download({ blob, filename }) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

// ---------- settings ----------

const PRESET_RESOLUTIONS = ['1920', '3840', '4096'];

async function renderStorageInfo() {
  const info = $('#storage-info');
  const btn = $('#persist-storage');
  if (!navigator.storage?.estimate) {
    info.textContent = 'Storage information is not available in this browser.';
    btn.hidden = true;
    return;
  }
  const [{ usage, quota }, persisted] = await Promise.all([navigator.storage.estimate(), navigator.storage.persisted?.()]);
  info.textContent = `${(usage / 1048576).toFixed(1)} MB used of ~${(quota / 1073741824).toFixed(1)} GB available. ` +
    (persisted
      ? 'Storage is persistent: the browser will not evict it automatically.'
      : 'Storage is not persistent: the browser may evict it when the device runs low on space.');
  btn.hidden = !!persisted || !navigator.storage.persist;
}

$('#persist-storage').addEventListener('click', async () => {
  const granted = await navigator.storage.persist().catch(() => false);
  await renderStorageInfo();
  if (!granted) {
    await ask({
      title: 'Not granted',
      message: 'The browser declined persistent storage. Chrome grants it automatically to installed apps ' +
        '(Add to Home screen / Install) and frequently used sites; Firefox asks you; Safari grants it to ' +
        'Home Screen apps. Install the app and try again.',
      ok: 'OK',
    });
  } else {
    toast('Persistent storage granted');
  }
});

$('#delete-all').addEventListener('click', async () => {
  const [projects, photos] = await Promise.all([db.listProjects(), db.countPhotos()]);
  if (!projects.length) { toast('There is no data to delete.'); return; }
  const first = await ask({
    title: 'Delete all data?',
    message: `This permanently deletes ${projects.length} project${projects.length === 1 ? '' : 's'} and ` +
      `${photos} photo${photos === 1 ? '' : 's'} stored on this device. Export anything you want to keep first.`,
    ok: 'Continue',
  });
  if (!first) return;
  const second = await ask({
    title: 'Are you absolutely sure?',
    message: 'This cannot be undone. All projects and photos will be gone.',
    ok: 'Delete everything',
  });
  if (!second) return;
  await db.deleteAll();
  saveSettings({ lastProjectId: null });
  $('#dlg-settings').close('deleted');
  toast('All data deleted');
  if (location.hash === '#/' || location.hash === '') route(); else location.hash = '#/';
});

function syncResolutionInputs() {
  const form = $('#dlg-settings form');
  const custom = form.resolution.value === 'custom';
  $('#custom-resolution-row').hidden = !custom;
  form.customResolution.required = custom;
}
$('#dlg-settings select[name=resolution]').addEventListener('change', () => {
  syncResolutionInputs();
  const form = $('#dlg-settings form');
  if (form.resolution.value === 'custom') form.customResolution.focus();
});

$('#open-settings').addEventListener('click', async () => {
  const s = getSettings();
  const form = $('#dlg-settings form');
  form.accuracy.value = s.accuracy;
  form.maxFixAge.value = s.maxFixAge;
  form.allowInaccurate.checked = s.allowInaccurate;
  const preset = PRESET_RESOLUTIONS.includes(String(s.resolution));
  form.resolution.value = preset ? String(s.resolution) : 'custom';
  form.customResolution.value = preset ? '' : s.resolution;
  syncResolutionInputs();
  const stream = $('#stream-info');
  stream.hidden = !camera.active;
  if (camera.active) stream.textContent = `Current camera stream: ${camera.video.videoWidth} × ${camera.video.videoHeight}`;
  form.captureQuality.value = s.captureQuality;
  $('#storage-info').textContent = '';
  renderStorageInfo();
  $('#dlg-settings').showModal();
});

$('#dlg-settings').addEventListener('close', () => {
  const dlg = $('#dlg-settings');
  if (dlg.returnValue !== 'save') return;
  const form = dlg.querySelector('form');
  const prevRes = getSettings().resolution;
  const resolution = form.resolution.value === 'custom'
    ? Math.round(Number(form.customResolution.value))
    : Number(form.resolution.value);
  saveSettings({
    accuracy: Number(form.accuracy.value),
    maxFixAge: Number(form.maxFixAge.value),
    allowInaccurate: form.allowInaccurate.checked,
    resolution,
    captureQuality: Number(form.captureQuality.value),
  });
  if (!$('#view-camera').hidden) {
    renderGps();
    if (prevRes !== getSettings().resolution) startCamera();
  } else if (currentProject) {
    renderProject();
  }
});

// ---------- boot ----------

window.addEventListener('hashchange', route);
route();

// Service worker: a new version installs in the background and waits; we offer
// a reload instead of swapping code under a running session (e.g. mid-capture).
if ('serviceWorker' in navigator) {
  let updateRequested = false;
  const offerUpdate = (worker) => {
    $('#update-banner').hidden = false;
    $('#update-reload').onclick = () => { updateRequested = true; worker.postMessage('skip-waiting'); };
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateRequested) location.reload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
      });
    });
    // Installed PWAs can stay open for days; check for a new version whenever we come back.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch((e) => console.warn('SW registration failed', e));
}
