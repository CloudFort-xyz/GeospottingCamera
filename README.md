# GeoSpotting Camera

A zero-dependency Progressive Web App for taking photos tagged with high-precision GPS coordinates, organised in projects, and exported as resized JPEGs with a CSV in a ZIP file.

## Features

- **Projects**: separate photo collections, each with its own name, sequence numbers and export.
- **Live viewfinder** (`getUserMedia`, rear camera, up to the device's maximum stream resolution), plus a **system camera** button (`<input capture>`) as a fallback, or for full-sensor photos.
- **Accuracy gate**: a continuous `watchPosition({enableHighAccuracy:true, maximumAge:0})` feeds a live indicator (`±3.2 m / 4 m`). The shutter turns green, amber or red for OK, too coarse, or stale/no fix.
  - The default target is **4 m** and the fix may be at most 5 s old. Both are adjustable in Settings.
  - When the target isn't met, the frame is still captured at that instant, and you're asked whether to save it. In Settings you can switch this to a hard block instead.
  - If the fix is stale (e.g. iOS stops emitting updates while the device is stationary), the shutter first asks for a fresh fix, waiting up to 5 s.
- **Compass direction**: the direction the rear camera points is recorded at the shutter instant and shown live in the camera view.
  - Android/Chrome: computed from `deviceorientationabsolute` using all three Euler angles, so it works whether the phone is upright, tilted, in landscape, or (falling back to the top edge) flat.
  - iOS/Safari: `webkitCompassHeading`. iOS requires a permission prompt from a tap; it's requested when you open the camera, press the shutter, or tap the GPS indicator.
  - Compass headings are magnetic (`GPSImgDirectionRef=M`). Without a compass reading, the GPS course over ground is used while you're moving (`T`). System-camera photos get no direction.
- **Photo details**:
  - **Live distance and bearing** from your current position to the photo's saved location, with the combined uncertainty. An arrow points to the spot, relative to where the phone points when the compass is live, otherwise north-up.
  - **Set to current location** replaces a photo's coordinates with your current fix, using the same accuracy gate as capture, and rewrites the EXIF in the stored JPEG. The original fix is kept in the database. The photo's direction is left unchanged.
- **Metadata** is written into every JPEG (originals and exports):
  - Standard EXIF GPS IFD: `GPSLatitude`/`GPSLongitude` as D/M/S rationals with 1/10000″ resolution (≈3 mm), `GPSHPositioningError` (the reported accuracy), `GPSAltitude`, `GPSDateStamp`/`GPSTimeStamp`, `GPSMapDatum=WGS-84`, and `GPSImgDirection`/`GPSImgDirectionRef`.
  - `DateTimeOriginal` and `OffsetTimeOriginal`.
  - A JPEG `COM` segment with decimal values, as a redundant, human-readable copy: `GEOSPOT lat=50.85033960 lon=4.35171030 acc=2.50m …`.
- **Export**: photos are proportionally scaled to fit inside a max width and/or max height. Images are never upscaled, and step-halving keeps the downscale quality good. Each export is re-encoded at a chosen JPEG quality, re-tagged, and zipped as:
  ```
  <project>/<project>_0001.jpg
  <project>/<project>_0002.jpg
  <project>/locations.csv   # filename,latitude,longitude,accuracy_m,altitude_m,direction_deg,direction_ref,taken_at
  ```
  The ZIP is downloaded directly, or shared through the Web Share API (on mobile, where available).
- **Offline**: the app shell is precached by a service worker. Photos live in IndexedDB.
- **Settings**:
  - **Camera resolution**: Full HD, 4K, max available, or a **custom width**. The browser treats the width as a preference, so Settings shows the actual stream size the camera delivered.
  - **Persistent storage**: the browser's `navigator.storage.persist()`. Settings shows usage and persistence status, with a button to request it; it's also requested silently on the first capture. Chrome grants it automatically to installed PWAs and frequently used sites, Firefox asks, and Safari grants it to Home Screen apps.
  - **Delete all data**: removes every project and photo after two confirmations.
- Screen wake lock while the camera is open. On desktop, Space/Enter takes a photo and Esc closes the camera.

## Running

No build step and no runtime dependencies: any static host works. Camera and geolocation require a **secure context** (HTTPS, or `http://localhost`).

```sh
npm start            # http://localhost:8080 (tiny Node static server)
npm test             # unit tests: EXIF round-trip via Pillow, ZIP via `unzip -t`, CSV
npm run test:e2e     # Playwright + fake camera + spoofed GPS: capture → export → verify ZIP/EXIF
npm run icons        # re-render PNG icons from icons/icon.svg
```

The tests need `python3` with Pillow, `unzip`, and `playwright` (with Chromium) available to Node.

### Deployment (GitHub Pages)

`.github/workflows/pages.yml` runs the unit and e2e tests on every push and pull request. Pushes to the **default branch** are then published to GitHub Pages; only the app files are published, not the tests or scripts.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**. Pages on a private repository requires a paid GitHub plan, and the published site is public unless you're on Enterprise Cloud with access control.

Bump `VERSION` in `sw.js` on each release, so installed clients pick up the new app shell. Any other static HTTPS host (Netlify, S3/CloudFront, …) works too.

## Architecture

| File | Responsibility |
| --- | --- |
| `js/app.js` | UI controller, hash routing (`#/`, `#/p/<id>`, `#/p/<id>/camera`), dialogs |
| `js/compass.js` | Rear-camera heading from device orientation (Android absolute / iOS webkitCompassHeading), smoothed |
| `js/geomath.js` | Haversine distance, bearing, cardinal points, camera heading from Euler angles |
| `js/geo.js` | `GeoTracker`: watch, freshness (by local receipt time), on-demand refresh |
| `js/camera.js` | `getUserMedia` viewfinder, frame capture, orientation-aware resize to JPEG |
| `js/exif.js` | EXIF/TIFF writer (IFD0 + Exif + GPS IFDs) and JPEG segment splicing |
| `js/zip.js` | ZIP writer (STORE, CRC-32, UTF-8 names), output as a `Blob` from parts |
| `js/csv.js` | RFC 4180 CSV |
| `js/export.js` | Project → resized, tagged JPEGs + CSV → ZIP |
| `js/db.js` | IndexedDB: `projects`, `photos` (original blob, thumbnail, GPS metadata) |
| `js/settings.js` | Per-device preferences (localStorage) |
| `sw.js` | Cache-first app shell with background revalidation |

## Notes on accuracy

- Browsers report `coords.accuracy` as a 68% confidence radius in metres. Phones outdoors with a clear sky typically reach 2–5 m. Indoors, or near tall buildings, expect 10 m and worse, so the 4 m gate will legitimately hold you back there.
- Magnetometers are easily disturbed by nearby metal, cars and phone cases. Do a figure-eight with the phone to calibrate if the heading looks off. The heading is magnetic north; in Western Europe declination is currently within a few degrees.
- Freshness is measured from when the browser *delivered* the fix, not `position.timestamp`, which is skewed on some Android devices.
- Viewfinder captures are limited to the camera stream resolution, which is often lower than the full sensor. Since exports are downscaled, this is usually fine. When you need full sensor resolution, use the system-camera button: the photo is re-encoded to bake in EXIF orientation, and its metadata is replaced with the app's GPS data.
