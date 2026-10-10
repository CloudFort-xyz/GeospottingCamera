// Tiny static dev server (camera + geolocation work on http://localhost).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

/**
 * @param {string} root  directory to serve
 * @param {{cacheControl?: string}} [opts]  e.g. 'max-age=600' to mimic GitHub Pages
 */
export function createStaticServer(root, { cacheControl = 'no-cache' } = {}) {
  return createServer(async (req, res) => {
    let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (path.endsWith('/')) path += 'index.html';
    const file = join(root, path);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': cacheControl });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
}

export const server = createStaticServer(fileURLToPath(new URL('..', import.meta.url)));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8080;
  server.listen(port, () => console.log(`Serving on http://localhost:${port}`));
}
