// Live viewfinder via getUserMedia and frame capture to JPEG.

export class Camera {
  /** @type {MediaStream|null} */
  stream = null;

  constructor(video) { this.video = video; }

  async start({ resolution = 4096, facingMode = 'environment' } = {}) {
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: resolution },
        height: { ideal: resolution },
      },
    });
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  get active() { return !!this.stream; }

  /** Grabs the current frame at full stream resolution. */
  capture(quality = 0.95) {
    const { videoWidth: w, videoHeight: h } = this.video;
    if (!w || !h) throw new Error('Camera not ready');
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(this.video, 0, 0, w, h);
    return canvasToJpeg(canvas, quality);
  }
}

export function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG encoding failed'))), 'image/jpeg', quality));
}

/**
 * Decodes any image blob (respecting EXIF orientation) and re-encodes it to a
 * JPEG fitting within maxW x maxH (never upscaling). Uses successive halving
 * for good downscale quality without relying on resizeQuality support.
 */
export async function resizeToJpeg(blob, { maxWidth = Infinity, maxHeight = Infinity, quality = 0.85 } = {}) {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const scale = Math.min(1, (maxWidth || Infinity) / bmp.width, (maxHeight || Infinity) / bmp.height);
  const tw = Math.max(1, Math.round(bmp.width * scale));
  const th = Math.max(1, Math.round(bmp.height * scale));

  let src = bmp, sw = bmp.width, sh = bmp.height;
  while (sw / 2 >= tw && sh / 2 >= th) {
    const c = document.createElement('canvas');
    c.width = Math.round(sw / 2); c.height = Math.round(sh / 2);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    src = c; sw = c.width; sh = c.height;
  }
  const out = document.createElement('canvas');
  out.width = tw; out.height = th;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, tw, th);
  bmp.close();
  return { blob: await canvasToJpeg(out, quality), width: tw, height: th };
}
