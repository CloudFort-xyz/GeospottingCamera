// Geodesy and orientation helpers (pure functions, unit-tested).

const R = 6371008.8; // mean Earth radius (m)
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
export const norm360 = (d) => ((d % 360) + 360) % 360;

/** Great-circle distance in metres (haversine; < 0.5% error, mm-level at short range). */
export function distance(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from point 1 to point 2, degrees clockwise from true north. */
export function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
    Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return norm360(deg(Math.atan2(y, x)));
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const cardinal = (d) => POINTS[Math.round(norm360(d) / 22.5) % 16];

/**
 * Direction the rear camera points, from W3C DeviceOrientation Euler angles
 * (alpha about Z, beta about X, gamma about Y; intrinsic Z-X'-Y'').
 * The camera looks along the device's -Z axis; we rotate that into the earth
 * frame (x=east, y=north, z=up) and take its horizontal heading. When the
 * device is held nearly flat the camera points at the ground and the heading
 * is ill-defined, so we fall back to the direction the top edge points.
 * Independent of screen orientation.
 * @returns {number} degrees clockwise from the reference north of alpha
 */
export function cameraHeading(alpha, beta, gamma) {
  const [a, b, g] = [rad(alpha), rad(beta), rad(gamma)];
  const [ca, sa, cb, sb, cg, sg] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(g), Math.sin(g)];
  const east = -(ca * sg + sa * sb * cg);
  const north = ca * sb * cg - sa * sg;
  if (Math.hypot(east, north) > 0.35) return norm360(deg(Math.atan2(east, north)));
  // Flat: heading of the device's +Y (top edge).
  return norm360(deg(Math.atan2(-sa * cb, ca * cb)));
}
