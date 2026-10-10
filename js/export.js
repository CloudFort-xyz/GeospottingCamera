// Project export: resized, GPS-tagged JPEGs + CSV, packed into a ZIP.

import { listPhotos } from './db.js';
import { resizeToJpeg } from './camera.js';
import { injectGps } from './exif.js';
import { ZipWriter } from './zip.js';
import { toCsv } from './csv.js';

export function slugify(s) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
}

export function photoFilename(project, photo) {
  return `${slugify(project.name)}_${String(photo.seq).padStart(4, '0')}.jpg`;
}

/**
 * @param {object} project
 * @param {{maxWidth:number, maxHeight:number, quality:number}} opts
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<{blob: Blob, filename: string}>}
 */
export async function exportProject(project, opts, onProgress = () => {}) {
  const photos = await listPhotos(project.id);
  if (!photos.length) throw new Error('This project has no photos yet');
  const zip = new ZipWriter();
  const folder = slugify(project.name);
  const rows = [['filename', 'latitude', 'longitude', 'accuracy_m', 'altitude_m', 'direction_deg', 'direction_ref', 'taken_at']];

  for (const [i, p] of photos.entries()) {
    onProgress(i, photos.length);
    const { blob } = await resizeToJpeg(p.blob, opts);
    const jpeg = injectGps(new Uint8Array(await blob.arrayBuffer()), p);
    const name = photoFilename(project, p);
    zip.add(`${folder}/${name}`, jpeg, new Date(p.takenAt));
    rows.push([
      name, p.lat.toFixed(8), p.lon.toFixed(8),
      p.accuracy?.toFixed(2) ?? '', Number.isFinite(p.altitude) ? p.altitude.toFixed(2) : '',
      Number.isFinite(p.heading) ? p.heading.toFixed(1) : '', Number.isFinite(p.heading) ? p.headingRef : '',
      new Date(p.takenAt).toISOString(),
    ]);
  }
  zip.add(`${folder}/locations.csv`, toCsv(rows));
  onProgress(photos.length, photos.length);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return { blob: zip.finish(), filename: `${folder}_${stamp}.zip` };
}
