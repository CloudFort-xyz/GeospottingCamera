import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distance, bearing, cardinal, cameraHeading } from '../js/geomath.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} !~ ${b}`);
const angNear = (a, b, tol, msg) => near(((a - b + 540) % 360) - 180, 0, tol, `${msg ?? ''} ${a} vs ${b}`);

test('distance', () => {
  // 1e-5 deg latitude ~ 1.11 m
  near(distance(50.85, 4.35, 50.85001, 4.35), 1.112, 0.002);
  // Brussels -> Paris ~ 264 km
  near(distance(50.8466, 4.3528, 48.8566, 2.3522) / 1000, 264, 2);
  assert.equal(distance(1, 2, 1, 2), 0);
});

test('bearing and cardinal', () => {
  near(bearing(0, 0, 1, 0), 0, 1e-9);
  near(bearing(0, 0, 0, 1), 90, 1e-9);
  near(bearing(0, 0, -1, 0), 180, 1e-9);
  near(bearing(0, 0, 0, -1), 270, 1e-9);
  assert.equal(cardinal(0), 'N');
  assert.equal(cardinal(359), 'N');
  assert.equal(cardinal(45), 'NE');
  assert.equal(cardinal(200), 'SSW');
});

test('camera heading from device orientation', () => {
  // Upright portrait, camera facing north / east / south / west (alpha is counter-clockwise).
  angNear(cameraHeading(0, 90, 0), 0, 1e-9, 'N');
  angNear(cameraHeading(270, 90, 0), 90, 1e-9, 'E');
  angNear(cameraHeading(180, 90, 0), 180, 1e-9, 'S');
  angNear(cameraHeading(90, 90, 0), 270, 1e-9, 'W');
  // Tilted upright (beta 60) still points the same way.
  angNear(cameraHeading(270, 60, 0), 90, 1e-9, 'tilted E');
  // Landscape upright (beta 0, gamma -90): camera faces north when alpha = 90 and east when alpha = 0.
  angNear(cameraHeading(90, 0, -90), 0, 1e-9, 'landscape N');
  angNear(cameraHeading(0, 0, -90), 90, 1e-9, 'landscape E');
  // Flat on a table, top edge to the east -> fall back to top-edge heading.
  angNear(cameraHeading(270, 0, 0), 90, 1e-9, 'flat E');
});
