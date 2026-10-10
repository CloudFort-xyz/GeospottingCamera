// User preferences (small, per-device) kept in localStorage.

const KEY = 'geospotting-camera:settings';

export const DEFAULTS = {
  accuracy: 4,          // required horizontal accuracy in metres
  maxFixAge: 5,         // seconds a fix stays valid for tagging a photo
  allowInaccurate: true, // ask before saving when accuracy target isn't met (false = block)
  captureQuality: 0.95, // JPEG quality for stored originals
  resolution: 4096,     // requested camera width (ideal); 4096 = max available
  exportMaxWidth: 1920,
  exportMaxHeight: 1920,
  exportQuality: 0.85,
  lastProjectId: null,
};

let cache;

export function getSettings() {
  if (!cache) {
    try { cache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
    catch { cache = { ...DEFAULTS }; }
  }
  return cache;
}

export function saveSettings(patch) {
  cache = { ...getSettings(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* storage unavailable */ }
  return cache;
}
