// Minimal EXIF writer focused on GPS metadata.
//
// Builds a big-endian TIFF/EXIF APP1 segment containing IFD0, an Exif sub-IFD
// (DateTimeOriginal) and a GPS sub-IFD, then splices it into a JPEG, replacing
// any existing EXIF/JFIF header. Coordinates are stored as deg/min/sec
// rationals with 1/10000 arc-second resolution (~3 mm), so the standard GPS
// tags are precise enough by a wide margin; a JPEG COM segment carrying the
// decimal values is added as a human-readable fallback.

const TYPE = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5 };
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };

const TAG = {
  Software: 0x0131,
  DateTime: 0x0132,
  ExifIFD: 0x8769,
  GPSIFD: 0x8825,
  DateTimeOriginal: 0x9003,
  OffsetTimeOriginal: 0x9011,
  GPSVersionID: 0x0000,
  GPSLatitudeRef: 0x0001,
  GPSLatitude: 0x0002,
  GPSLongitudeRef: 0x0003,
  GPSLongitude: 0x0004,
  GPSAltitudeRef: 0x0005,
  GPSAltitude: 0x0006,
  GPSTimeStamp: 0x0007,
  GPSImgDirectionRef: 0x0010,
  GPSImgDirection: 0x0011,
  GPSMapDatum: 0x0012,
  GPSDateStamp: 0x001d,
  GPSHPositioningError: 0x001f,
};

/** Decimal degrees -> [[deg,1],[min,1],[sec*1e4,1e4]] without rounding carry issues. */
export function toDmsRationals(decimal) {
  const SUB = 10000;
  const total = Math.round(Math.abs(decimal) * 3600 * SUB);
  const deg = Math.floor(total / (3600 * SUB));
  const rem = total - deg * 3600 * SUB;
  const min = Math.floor(rem / (60 * SUB));
  const sec = rem - min * 60 * SUB;
  return [[deg, 1], [min, 1], [sec, SUB]];
}

function toRational(value, denominator = 1000) {
  return [Math.round(Math.abs(value) * denominator), denominator];
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

function exifDateTime(d) {
  return `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function exifOffset(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

function entry(tag, type, value) {
  // value: string for ASCII, array of numbers for BYTE/SHORT/LONG, array of [n,d] for RATIONAL
  if (type === TYPE.ASCII) {
    const bytes = new TextEncoder().encode(value + '\0');
    return { tag, type, count: bytes.length, bytes };
  }
  const count = value.length;
  const bytes = new Uint8Array(count * TYPE_SIZE[type]);
  const dv = new DataView(bytes.buffer);
  value.forEach((v, i) => {
    switch (type) {
      case TYPE.BYTE: dv.setUint8(i, v); break;
      case TYPE.SHORT: dv.setUint16(i * 2, v); break;
      case TYPE.LONG: dv.setUint32(i * 4, v); break;
      case TYPE.RATIONAL: dv.setUint32(i * 8, v[0]); dv.setUint32(i * 8 + 4, v[1]); break;
    }
  });
  return { tag, type, count, bytes };
}

function ifdSize(entries) {
  const dataSize = entries.reduce((s, e) => s + (e.bytes.length > 4 ? e.bytes.length + (e.bytes.length & 1) : 0), 0);
  return 2 + entries.length * 12 + 4 + dataSize;
}

/** Writes an IFD at `offset` (relative to TIFF header) into dv; returns nothing. */
function writeIfd(dv, u8, offset, entries) {
  entries.sort((a, b) => a.tag - b.tag);
  dv.setUint16(offset, entries.length);
  let dataOffset = offset + 2 + entries.length * 12 + 4;
  entries.forEach((e, i) => {
    const p = offset + 2 + i * 12;
    dv.setUint16(p, e.tag);
    dv.setUint16(p + 2, e.type);
    dv.setUint32(p + 4, e.count);
    if (e.bytes.length <= 4) {
      u8.set(e.bytes, p + 8);
    } else {
      dv.setUint32(p + 8, dataOffset);
      u8.set(e.bytes, dataOffset);
      dataOffset += e.bytes.length + (e.bytes.length & 1);
    }
  });
  dv.setUint32(offset + 2 + entries.length * 12, 0); // no next IFD
}

/**
 * @param {object} meta
 * @param {number} meta.lat
 * @param {number} meta.lon
 * @param {number} [meta.accuracy]  horizontal accuracy in metres
 * @param {number|null} [meta.altitude]  metres above WGS-84 ellipsoid
 * @param {number|null} [meta.heading]   degrees true
 * @param {number} meta.fixTime     ms epoch of the GPS fix
 * @param {number} meta.takenAt     ms epoch of capture
 * @param {string} [meta.software]
 * @returns {Uint8Array} complete APP1 segment including marker and length
 */
export function buildExifSegment(meta) {
  const taken = new Date(meta.takenAt);
  const fix = new Date(meta.fixTime ?? meta.takenAt);

  const ifd0 = [
    entry(TAG.Software, TYPE.ASCII, meta.software || 'GeoSpotting Camera'),
    entry(TAG.DateTime, TYPE.ASCII, exifDateTime(taken)),
    entry(TAG.ExifIFD, TYPE.LONG, [0]), // patched below
    entry(TAG.GPSIFD, TYPE.LONG, [0]),  // patched below
  ];
  const exif = [
    entry(TAG.DateTimeOriginal, TYPE.ASCII, exifDateTime(taken)),
    entry(TAG.OffsetTimeOriginal, TYPE.ASCII, exifOffset(taken)),
  ];
  const secs = fix.getUTCSeconds() + fix.getUTCMilliseconds() / 1000;
  const gps = [
    entry(TAG.GPSVersionID, TYPE.BYTE, [2, 3, 0, 0]),
    entry(TAG.GPSLatitudeRef, TYPE.ASCII, meta.lat >= 0 ? 'N' : 'S'),
    entry(TAG.GPSLatitude, TYPE.RATIONAL, toDmsRationals(meta.lat)),
    entry(TAG.GPSLongitudeRef, TYPE.ASCII, meta.lon >= 0 ? 'E' : 'W'),
    entry(TAG.GPSLongitude, TYPE.RATIONAL, toDmsRationals(meta.lon)),
    entry(TAG.GPSTimeStamp, TYPE.RATIONAL, [[fix.getUTCHours(), 1], [fix.getUTCMinutes(), 1], toRational(secs, 1000)]),
    entry(TAG.GPSMapDatum, TYPE.ASCII, 'WGS-84'),
    entry(TAG.GPSDateStamp, TYPE.ASCII, `${fix.getUTCFullYear()}:${pad(fix.getUTCMonth() + 1)}:${pad(fix.getUTCDate())}`),
  ];
  if (Number.isFinite(meta.altitude)) {
    gps.push(entry(TAG.GPSAltitudeRef, TYPE.BYTE, [meta.altitude < 0 ? 1 : 0]));
    gps.push(entry(TAG.GPSAltitude, TYPE.RATIONAL, [toRational(meta.altitude, 100)]));
  }
  if (Number.isFinite(meta.heading)) {
    gps.push(entry(TAG.GPSImgDirectionRef, TYPE.ASCII, 'T'));
    gps.push(entry(TAG.GPSImgDirection, TYPE.RATIONAL, [toRational(meta.heading % 360, 100)]));
  }
  if (Number.isFinite(meta.accuracy)) {
    gps.push(entry(TAG.GPSHPositioningError, TYPE.RATIONAL, [toRational(meta.accuracy, 100)]));
  }

  const ifd0Offset = 8;
  const exifOffsetPos = ifd0Offset + ifdSize(ifd0);
  const gpsOffsetPos = exifOffsetPos + ifdSize(exif);
  const tiffSize = gpsOffsetPos + ifdSize(gps);

  ifd0.find((e) => e.tag === TAG.ExifIFD).bytes = entry(0, TYPE.LONG, [exifOffsetPos]).bytes;
  ifd0.find((e) => e.tag === TAG.GPSIFD).bytes = entry(0, TYPE.LONG, [gpsOffsetPos]).bytes;

  const header = 2 + 2 + 6; // marker + length + "Exif\0\0"
  const seg = new Uint8Array(header + tiffSize);
  const dv = new DataView(seg.buffer);
  dv.setUint16(0, 0xffe1);
  dv.setUint16(2, seg.length - 2);
  seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);

  const tiff = new Uint8Array(seg.buffer, header);
  const tdv = new DataView(seg.buffer, header);
  tiff.set([0x4d, 0x4d]); // "MM" big-endian
  tdv.setUint16(2, 0x002a);
  tdv.setUint32(4, ifd0Offset);
  writeIfd(tdv, tiff, ifd0Offset, ifd0);
  writeIfd(tdv, tiff, exifOffsetPos, exif);
  writeIfd(tdv, tiff, gpsOffsetPos, gps);

  if (seg.length > 0xffff) throw new Error('EXIF segment too large');
  return seg;
}

/** Builds a JPEG COM segment. */
export function buildCommentSegment(text) {
  const body = new TextEncoder().encode(text);
  const seg = new Uint8Array(4 + body.length);
  const dv = new DataView(seg.buffer);
  dv.setUint16(0, 0xfffe);
  dv.setUint16(2, body.length + 2);
  seg.set(body, 4);
  return seg;
}

export function gpsComment(meta) {
  const parts = [`lat=${meta.lat.toFixed(8)}`, `lon=${meta.lon.toFixed(8)}`];
  if (Number.isFinite(meta.accuracy)) parts.push(`acc=${meta.accuracy.toFixed(2)}m`);
  if (Number.isFinite(meta.altitude)) parts.push(`alt=${meta.altitude.toFixed(2)}m`);
  parts.push(`fix=${new Date(meta.fixTime ?? meta.takenAt).toISOString()}`);
  return `GEOSPOT ${parts.join(' ')}`;
}

/**
 * Returns a new JPEG byte array with existing APP0 (JFIF), APP1 (Exif/XMP) and
 * COM segments removed and our EXIF + COM segments inserted right after SOI.
 * @param {Uint8Array} jpeg
 * @param {object} meta  see buildExifSegment
 */
export function injectGps(jpeg, meta) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Not a JPEG');
  const keep = [];
  let pos = 2;
  while (pos < jpeg.length) {
    if (jpeg[pos] !== 0xff) throw new Error(`Corrupt JPEG at ${pos}`);
    const marker = jpeg[pos + 1];
    if (marker === 0xff) { pos++; continue; } // fill byte
    if (marker === 0xda) { keep.push(jpeg.subarray(pos)); break; } // SOS: rest is entropy-coded data
    if (marker >= 0xd0 && marker <= 0xd7) { keep.push(jpeg.subarray(pos, pos + 2)); pos += 2; continue; }
    const len = (jpeg[pos + 2] << 8) | jpeg[pos + 3];
    const end = pos + 2 + len;
    const drop = marker === 0xe0 || marker === 0xe1 || marker === 0xfe;
    if (!drop) keep.push(jpeg.subarray(pos, end));
    pos = end;
  }
  const exif = buildExifSegment(meta);
  const com = buildCommentSegment(gpsComment(meta));
  const out = new Uint8Array(2 + exif.length + com.length + keep.reduce((s, k) => s + k.length, 0));
  out.set([0xff, 0xd8]);
  let o = 2;
  for (const part of [exif, com, ...keep]) { out.set(part, o); o += part.length; }
  return out;
}
