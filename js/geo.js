// Continuous high-accuracy geolocation tracking.

export class GeoTracker extends EventTarget {
  /** @type {GeolocationPosition|null} */
  last = null;
  /** Local clock time the last fix was delivered. Used for freshness instead of
   * position.timestamp, which is skewed on some devices (GNSS vs system clock). */
  receivedAt = 0;
  error = null;
  #watchId = null;

  start() {
    if (this.#watchId !== null) return;
    if (!('geolocation' in navigator)) {
      this.error = { message: 'Geolocation not supported' };
      this.dispatchEvent(new Event('change'));
      return;
    }
    this.#watchId = navigator.geolocation.watchPosition(
      (pos) => { this.#set(pos); this.error = null; },
      (err) => { this.error = err; this.dispatchEvent(new Event('change')); },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
  }

  #set(pos) {
    this.last = pos;
    this.receivedAt = Date.now();
    this.dispatchEvent(new Event('change'));
  }

  stop() {
    if (this.#watchId !== null) navigator.geolocation.clearWatch(this.#watchId);
    this.#watchId = null;
  }

  /**
   * Requests a one-shot fresh fix. Some platforms (notably iOS) stop emitting
   * watchPosition updates while the device is stationary, so a "stale" fix
   * doesn't necessarily mean the GPS is gone.
   */
  refresh(timeout = 5000) {
    return new Promise((resolve) => {
      if (!('geolocation' in navigator)) return resolve(this.last);
      const start = Date.now();
      const finish = () => {
        clearTimeout(timer);
        this.removeEventListener('change', onChange);
        resolve(this.last);
      };
      // Whichever delivers first wins: the running watch or the one-shot request.
      const onChange = () => { if (this.receivedAt >= start) finish(); };
      const timer = setTimeout(finish, timeout);
      this.addEventListener('change', onChange);
      navigator.geolocation.getCurrentPosition(
        (pos) => this.#set(pos),
        () => {}, // keep waiting for the watch until the timeout
        { enableHighAccuracy: true, maximumAge: 0, timeout },
      );
    });
  }

  /** Age of the last fix in seconds (Infinity if none). */
  age(now = Date.now()) {
    return this.last ? Math.max(0, (now - this.receivedAt) / 1000) : Infinity;
  }

  /**
   * @returns {{state:'none'|'stale'|'coarse'|'ok', fix:object|null}}
   */
  evaluate({ accuracy, maxFixAge }) {
    if (!this.last) return { state: 'none', fix: null };
    const c = this.last.coords;
    const fix = {
      lat: c.latitude, lon: c.longitude, accuracy: c.accuracy,
      altitude: c.altitude, altitudeAccuracy: c.altitudeAccuracy,
      heading: Number.isFinite(c.heading) && c.speed > 0.5 ? c.heading : null, // course over ground (true north)
      fixTime: this.receivedAt,
    };
    if (this.age() > maxFixAge) return { state: 'stale', fix };
    if (c.accuracy > accuracy) return { state: 'coarse', fix };
    return { state: 'ok', fix };
  }
}
