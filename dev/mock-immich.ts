// A stand-in Immich server for the preview page, answering the same paths
// and response shapes as Immich v3 for one shared album. Photos are SVGs in
// the shapes phones produce, with a frame and corner marks so any cropping
// is visible. POST /dev/add simulates someone adding a photo from a phone.
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

export const DEMO_KEY = 'demo-key';
/** A second link to the same album with downloads turned off. */
export const NO_DOWNLOAD_KEY = 'nodl-key';
const ALBUM_ID = '6f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

interface MockAsset {
  id: string;
  label: string;
  w: number;
  h: number;
  video: boolean;
  /** An animated GIF: a photo with a duration, served from /original. */
  gif?: boolean;
  taken: string; // UTC
  offset: number;
  uploaded: string;
  city: string | null;
  country: string | null;
  hue: number;
}

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const day = 86_400_000;
const now = Date.now();

const assets: MockAsset[] = [
  ['iPhone landscape 4:3', 4032, 3024, false, '2026-07-04T23:30:00Z', -5, 'Chicago', 'United States of America'],
  ['iPhone portrait 3:4', 3024, 4032, false, '2026-08-15T17:10:00Z', -5, 'Milwaukee', 'United States of America'],
  ['Widescreen 16:9', 3840, 2160, false, '2026-06-01T12:00:00Z', 2, 'Paris', 'France'],
  ['Square 1:1', 3024, 3024, false, '2025-12-25T15:00:00Z', -6, null, null],
  ['Panorama 3:1', 9000, 3000, false, '2026-09-20T19:45:00Z', -6, 'Denver', 'United States of America'],
  ['Story 9:16', 1080, 1920, false, '2026-10-01T22:00:00Z', -5, 'Chicago', 'United States of America'],
  ['Video 16:9', 1280, 720, true, '2026-10-10T20:00:00Z', -5, 'Evanston', 'United States of America'],
].map(([label, w, h, video, taken, offset, city, country], i) => ({
  id: uuid(i + 1), label: label as string, w: w as number, h: h as number, video: video as boolean,
  taken: taken as string, offset: offset as number, city: city as string | null, country: country as string | null,
  uploaded: new Date(now - (10 - i) * day).toISOString(), hue: (i * 53) % 360,
}));

assets.push({
  id: uuid(8), label: 'Animated GIF 4:3', w: 480, h: 360, video: false, gif: true,
  taken: '2026-10-15T18:00:00Z', offset: -5, uploaded: new Date(now - 2 * day).toISOString(),
  city: 'Chicago', country: 'United States of America', hue: 200,
});

let added = 0;

function svg(a: MockAsset, small: boolean): string {
  // Scale to the preview's long side the way Immich does (2160 here).
  const long = small ? 250 : 2160;
  const k = long / Math.max(a.w, a.h);
  const w = Math.round(a.w * k);
  const h = Math.round(a.h * k);
  const s = Math.min(w, h);
  const edge = Math.max(3, s * 0.012);
  const mark = s * 0.12;
  const corners = [[0, 0, 1, 1], [w, 0, -1, 1], [0, h, 1, -1], [w, h, -1, -1]]
    .map(([x, y, dx, dy]) => `<path d="M${x + dx * edge * 2} ${y + dy * (mark + edge * 2)} V${y + dy * edge * 2} H${x + dx * (mark + edge * 2)}" stroke="#fff" stroke-width="${edge * 1.5}" fill="none"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${a.hue},70%,45%)"/><stop offset="1" stop-color="hsl(${(a.hue + 60) % 360},70%,25%)"/></linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/>
<circle cx="${w / 2}" cy="${h / 2}" r="${s * 0.28}" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="${edge}"/>
<rect x="${edge / 2}" y="${edge / 2}" width="${w - edge}" height="${h - edge}" fill="none" stroke="#ffd60a" stroke-width="${edge}"/>
${corners}
<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-weight="700" font-size="${s * 0.075}" fill="#fff">${a.label}</text>
<text x="50%" y="${h / 2 + s * 0.11}" text-anchor="middle" font-family="sans-serif" font-size="${s * 0.045}" fill="rgba(255,255,255,0.8)">${a.w}×${a.h}</text>
</svg>`;
}

function bucketOf(a: MockAsset) {
  return `${a.taken.slice(0, 7)}-01`;
}

export function mockImmich(): Plugin {
  const sample = path.resolve(__dirname, 'sample.mp4');
  const gif = path.resolve(__dirname, 'sample.gif');
  return {
    name: 'mock-immich',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://x');
        const json = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (req.method === 'POST' && url.pathname === '/dev/add') {
          added += 1;
          const ratios: [number, number][] = [[4032, 3024], [3024, 4032], [1920, 1080]];
          const [w, h] = ratios[added % ratios.length];
          assets.push({
            id: uuid(100 + added), label: `New upload #${added}`, w, h, video: false,
            taken: new Date().toISOString(), offset: -5, uploaded: new Date().toISOString(),
            city: 'Chicago', country: 'United States of America', hue: (added * 97) % 360,
          });
          return json(200, { ok: true, count: assets.length });
        }
        if (!url.pathname.startsWith('/api/')) return next();
        const key = url.searchParams.get('key');
        if (key !== DEMO_KEY && key !== NO_DOWNLOAD_KEY) return json(401, { message: 'Invalid share key', error: 'Unauthorized', statusCode: 401 });

        if (url.pathname === '/api/shared-links/me') {
          return json(200, {
            id: uuid(999), key, type: 'ALBUM', allowUpload: true, allowDownload: true, showMetadata: true,
            password: null, slug: null, description: null, expiresAt: null, createdAt: new Date(now).toISOString(),
            userId: uuid(500), assets: [], album: { id: ALBUM_ID, albumName: 'Dashboard', assetCount: assets.length },
          });
        }
        if (url.pathname === '/api/timeline/buckets') {
          const counts = new Map<string, number>();
          for (const a of assets) counts.set(bucketOf(a), (counts.get(bucketOf(a)) ?? 0) + 1);
          return json(200, [...counts].sort((a, b) => b[0].localeCompare(a[0])).map(([timeBucket, count]) => ({ timeBucket, count })));
        }
        if (url.pathname === '/api/timeline/bucket') {
          const tb = (url.searchParams.get('timeBucket') ?? '').slice(0, 10);
          const list = assets.filter((a) => bucketOf(a) === tb);
          return json(200, {
            id: list.map((a) => a.id),
            isImage: list.map((a) => !a.video),
            ratio: list.map((a) => a.w / a.h),
            duration: list.map((a) => (a.video ? 6000 : a.gif ? 3000 : null)),
            fileCreatedAt: list.map((a) => a.taken),
            localOffsetHours: list.map((a) => a.offset),
            createdAt: list.map((a) => a.uploaded),
            city: list.map((a) => a.city),
            country: list.map((a) => a.country),
            isTrashed: list.map(() => false),
            isFavorite: list.map(() => false),
            thumbhash: list.map((a) => `th${a.hue}`),
            livePhotoVideoId: list.map(() => null),
            ownerId: list.map(() => uuid(500)),
            visibility: list.map(() => 'timeline'),
            projectionType: list.map(() => null),
          });
        }
        const m = /^\/api\/assets\/([^/]+)\/(thumbnail|original|video\/playback)$/.exec(url.pathname);
        const a = m && assets.find((x) => x.id === m[1]);
        if (!m || !a) return json(404, { message: 'Not found' });
        if (m[2] === 'thumbnail') {
          res.setHeader('Content-Type', 'image/svg+xml');
          res.setHeader('Cache-Control', 'private, max-age=86400');
          return res.end(svg(a, url.searchParams.get('size') === 'thumbnail'));
        }
        if (m[2] === 'original') {
          // Like Immich, refuse originals when the link doesn't allow downloads.
          if (!a.gif || !fs.existsSync(gif) || key === NO_DOWNLOAD_KEY) return json(403, { message: 'Not allowed' });
          res.setHeader('Content-Type', 'image/gif');
          return fs.createReadStream(gif).pipe(res);
        }
        if (!a.video || !fs.existsSync(sample)) return json(404, { message: 'Not found' });
        res.setHeader('Content-Type', 'video/mp4');
        return fs.createReadStream(sample).pipe(res);
      });
    },
  };
}
