// Device compass: heading of the rear camera, in degrees from magnetic north.
//
// Android/Chrome: 'deviceorientationabsolute' gives earth-referenced Euler
// angles; we compute the rear-camera direction from all three angles.
// iOS/Safari: 'deviceorientation' carries webkitCompassHeading (tilt
// compensated by CoreLocation); access needs a permission request made from a
// user gesture (requestPermission()).

import { cameraHeading, norm360 } from './geomath.js';

export class Compass extends EventTarget {
  heading = null;   // degrees, magnetic
  accuracy = null;  // degrees (iOS only)
  updatedAt = 0;
  #started = false;
  #smooth = null;

  get needsPermission() {
    return typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function';
  }

  /** Call from a user gesture on iOS; harmless elsewhere. Returns whether listening. */
  async start() {
    if (this.#started) return true;
    if (typeof DeviceOrientationEvent === 'undefined') return false;
    if (this.needsPermission) {
      try {
        if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') return false;
      } catch { return false; } // not in a user gesture yet
    }
    this.#started = true;
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', (e) => this.#onAbsolute(e));
    } else {
      window.addEventListener('deviceorientation', (e) => this.#onIos(e));
    }
    return true;
  }

  #onAbsolute(e) {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;
    this.#update(cameraHeading(e.alpha, e.beta, e.gamma), null);
  }

  #onIos(e) {
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
      this.#update(e.webkitCompassHeading, e.webkitCompassAccuracy ?? null);
    } else if (e.absolute && e.alpha != null) {
      this.#update(cameraHeading(e.alpha, e.beta, e.gamma), null);
    }
  }

  #update(h, accuracy) {
    // Low-pass filter on the unit circle to tame magnetometer jitter.
    if (this.#smooth === null || Date.now() - this.updatedAt > 1000) this.#smooth = h;
    else {
      const d = ((h - this.#smooth + 540) % 360) - 180;
      this.#smooth = norm360(this.#smooth + d * 0.25);
    }
    this.heading = this.#smooth;
    this.accuracy = accuracy;
    this.updatedAt = Date.now();
    this.dispatchEvent(new Event('change'));
  }

  /** Current heading if fresh (< 1 s), else null. */
  current() {
    return this.heading !== null && Date.now() - this.updatedAt < 1000 ? this.heading : null;
  }
}
