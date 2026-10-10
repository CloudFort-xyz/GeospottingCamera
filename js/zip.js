// Minimal streaming-friendly ZIP writer (STORE method, no compression).
// JPEGs don't compress meaningfully, so storing keeps this tiny and fast.
// Output is assembled as a Blob from parts, so file data is never copied into
// one giant buffer. Limits: < 65535 entries and < 4 GiB total (no ZIP64).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, crc = 0) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

export class ZipWriter {
  #parts = [];
  #central = [];
  #offset = 0;

  /**
   * @param {string} name  path inside the archive ("/" separators)
   * @param {Uint8Array|string} data
   * @param {Date} [date]
   */
  add(name, data, date = new Date()) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(bytes);
    const { time, day } = dosDateTime(date);
    const FLAG_UTF8 = 0x0800;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, FLAG_UTF8, true);
    lv.setUint16(8, 0, true); // STORE
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, bytes.length, true);
    lv.setUint32(22, bytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 0x0314, true); // made by: UNIX, 2.0
    cv.setUint16(6, 20, true);
    cv.setUint16(8, FLAG_UTF8, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, bytes.length, true);
    cv.setUint32(24, bytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(38, (0o100644 << 16) >>> 0, true); // external attrs: regular file rw-r--r--
    cv.setUint32(42, this.#offset, true);
    cen.set(nameBytes, 46);

    this.#parts.push(local, bytes);
    this.#central.push(cen);
    this.#offset += local.length + bytes.length;
    if (this.#offset > 0xffffffff) throw new Error('ZIP exceeds 4 GiB');
  }

  /** @returns {Blob} */
  finish() {
    const cdSize = this.#central.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, this.#central.length, true);
    ev.setUint16(10, this.#central.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, this.#offset, true);
    return new Blob([...this.#parts, ...this.#central, end], { type: 'application/zip' });
  }
}
