// Immich access through an album's shared link. The link's key is the only
// credential: it lets the dashboard list that one album and load its photos,
// nothing else in the library.
//
// Listing goes through the host proxy, because Immich sends no CORS headers
// and the display's browser can't read its JSON directly. Photos and videos
// don't need the proxy: <img> and <video> load them straight from Immich.
//
// The parsers are exported and pure so they can be tested against recorded
// response shapes (Immich v3).

export const PLUGIN_ID = 'immich-slideshow';

// ── Fetch plumbing ──────────────────────────────────────────────────────────

export interface ProxyRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  payload?: string;
}

export interface ProxyAnswer {
  status: number;
  body: unknown;
}

export type Fetcher = (req: ProxyRequest) => Promise<ProxyAnswer>;

export function hostFetcher(): Fetcher {
  return async (req) => {
    const sdk = window.__HS_SDK__;
    if (!sdk?.pluginFetch) throw new Error('Host SDK unavailable');
    const res = await sdk.pluginFetch(PLUGIN_ID, req);
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep the text */ }
    return { status: res.status, body };
  };
}

// ── The share link ──────────────────────────────────────────────────────────

export interface ShareLink {
  /** `http://192.168.1.50:2283`, no trailing slash. */
  origin: string;
  /** `key=...` or `slug=...`, ready to append to an API URL. */
  auth: string;
}

export type LinkProblem = 'empty' | 'notALink' | 'notAShare';

/** Reads the link Immich's Share button gives you:
 *  `http://host:2283/share/<key>` or, with a custom URL, `http://host:2283/s/<slug>`. */
export function parseShareLink(input: string): ShareLink | LinkProblem {
  const text = input.trim();
  if (!text) return 'empty';
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return 'notALink';
  }
  const m = /\/(share|s)\/([^/?#]+)/.exec(url.pathname);
  if (!m) return 'notAShare';
  const value = encodeURIComponent(decodeURIComponent(m[2]));
  return { origin: url.origin, auth: m[1] === 'share' ? `key=${value}` : `slug=${value}` };
}

// ── Media URLs ──────────────────────────────────────────────────────────────

/** `preview` is a JPEG whose long side is set on the server (the installer
 *  sets 2160, enough for a full 4K screen); `thumbnail` is a small WebP. */
export type ImageSize = 'preview' | 'thumbnail';

export const imageUrl = (link: ShareLink, id: string, size: ImageSize, version?: string | null) =>
  `${link.origin}/api/assets/${id}/thumbnail?size=${size}&${link.auth}${version ? `&c=${encodeURIComponent(version)}` : ''}`;

/** The H.264 copy Immich transcodes iPhone videos into, or the original when
 *  no transcode was needed. */
export const videoUrl = (link: ShareLink, id: string) =>
  `${link.origin}/api/assets/${id}/video/playback?${link.auth}`;

/** The smallest Immich preview that still covers `px` on its long side. */
export function sizeFor(px: number): ImageSize {
  return px <= 250 ? 'thumbnail' : 'preview';
}

// ── The album ───────────────────────────────────────────────────────────────

export interface Asset {
  id: string;
  isVideo: boolean;
  /** width / height, as Immich reports it (already turned upright). */
  ratio: number;
  /** Video length in ms; 0 for photos or when unknown. */
  durationMs: number;
  /** When it was taken, as wall-clock time where it was taken, in ISO form
   *  without a zone (`2026-07-04T18:30:00`). Empty when unknown. */
  takenLocal: string;
  /** When it reached Immich (UTC ms). Newest uploads can play first. */
  uploadedAt: number;
  city: string;
  country: string;
  /** Changes when the asset's previews are regenerated; busts the browser cache. */
  version: string | null;
}

export interface Bucket {
  timeBucket: string;
  count: number;
}

export type Failure =
  | { kind: 'unreachable' } // no answer from Immich at all
  | { kind: 'proxy'; message: string } // the host proxy refused the request
  | { kind: 'linkGone' } // key unknown, expired or removed
  | { kind: 'password' } // the link asks for a password
  | { kind: 'unexpected'; status: number };

export class ImmichError extends Error {
  constructor(public failure: Failure) {
    super(failure.kind);
  }
}

function failureOf(a: ProxyAnswer): Failure {
  const b = (a.body ?? {}) as { error?: string; message?: string };
  const text = `${b.message ?? ''} ${b.error ?? ''}`;
  if (a.status === 401 && /password/i.test(text)) return { kind: 'password' };
  if (a.status === 401 || a.status === 403 || a.status === 404) {
    // The host proxy answers 403 for its own refusals; Immich for a bad key.
    if (/allowedDomains|blocked address|not installed|manifest not found|not allowed/i.test(text)) return { kind: 'proxy', message: text.trim() };
    return { kind: 'linkGone' };
  }
  if (/unreachable|timeout|timed out|ECONNREFUSED|EHOSTUNREACH/i.test(text)) return { kind: 'unreachable' };
  if (a.status >= 500) {
    if (/too large|domain|blocked/i.test(text)) return { kind: 'proxy', message: text.trim() };
    return { kind: 'unreachable' };
  }
  if (a.status === 429) return { kind: 'proxy', message: text.trim() || 'rate limited' };
  return { kind: 'unexpected', status: a.status };
}

async function getJson(fetch: Fetcher, url: string): Promise<unknown> {
  let answer: ProxyAnswer;
  try {
    answer = await fetch({ url });
  } catch {
    throw new ImmichError({ kind: 'unreachable' });
  }
  if (answer.status < 200 || answer.status >= 300) throw new ImmichError(failureOf(answer));
  if (typeof answer.body !== 'object' || answer.body === null) {
    throw new ImmichError({ kind: 'unexpected', status: answer.status });
  }
  return answer.body;
}

export interface LinkInfo {
  albumId: string | null;
  albumName: string;
  /** Present only for a link to hand-picked photos rather than an album. */
  assets: Asset[] | null;
}

export function parseLinkInfo(body: unknown): LinkInfo {
  const b = body as {
    type?: string;
    album?: { id?: string; albumName?: string } | null;
    assets?: unknown[];
  };
  if (b.type === 'INDIVIDUAL' || !b.album?.id) {
    return { albumId: null, albumName: '', assets: (b.assets ?? []).map(parseAssetDto).filter(isAsset) };
  }
  return { albumId: b.album.id, albumName: b.album.albumName ?? '', assets: null };
}

/** One `AssetResponseDto`, for links to hand-picked photos. */
export function parseAssetDto(raw: unknown): Asset | null {
  const a = raw as {
    id?: string; type?: string; width?: number | null; height?: number | null; duration?: unknown;
    localDateTime?: string; createdAt?: string; isTrashed?: boolean; thumbhash?: string | null;
    exifInfo?: { city?: string | null; country?: string | null } | null;
  };
  if (!a?.id || a.isTrashed || (a.type !== 'IMAGE' && a.type !== 'VIDEO')) return null;
  return {
    id: a.id,
    isVideo: a.type === 'VIDEO',
    ratio: a.width && a.height ? a.width / a.height : 0,
    durationMs: parseDuration(a.duration),
    takenLocal: (a.localDateTime ?? '').replace(/(\.\d+)?(Z|[+-]\d\d:?\d\d)?$/, ''),
    uploadedAt: Date.parse(a.createdAt ?? '') || 0,
    city: a.exifInfo?.city ?? '',
    country: a.exifInfo?.country ?? '',
    version: a.thumbhash ?? null,
  };
}

const isAsset = (a: Asset | null): a is Asset => a !== null;

export function parseBuckets(body: unknown): Bucket[] {
  if (!Array.isArray(body)) return [];
  return body
    .map((b) => ({ timeBucket: String((b as Bucket).timeBucket ?? ''), count: Number((b as Bucket).count) || 0 }))
    .filter((b) => b.timeBucket);
}

/** Immich v3 sends video length in ms; older servers sent `H:MM:SS.mmm`. */
export function parseDuration(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, v);
  if (typeof v !== 'string') return 0;
  const m = /^(\d+):(\d\d):(\d\d(?:\.\d+)?)$/.exec(v.trim());
  if (!m) return Number(v) || 0;
  return Math.round(((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000);
}

/** Wall-clock time where the photo was taken: UTC plus the offset Immich
 *  recorded, written without a zone so nothing re-shifts it. */
export function localTaken(utc: string, offsetHours: number): string {
  const t = Date.parse(utc);
  if (!Number.isFinite(t)) return '';
  return new Date(t + (Number.isFinite(offsetHours) ? offsetHours : 0) * 3_600_000).toISOString().slice(0, 19);
}

/** One time bucket's assets. Immich sends these as parallel arrays. */
export function parseBucket(body: unknown): Asset[] {
  const b = (body ?? {}) as Record<string, unknown[] | undefined>;
  const ids = b.id ?? [];
  const col = <T>(name: string, i: number): T | undefined => b[name]?.[i] as T | undefined;
  const out: Asset[] = [];
  ids.forEach((id, i) => {
    if (typeof id !== 'string' || col<boolean>('isTrashed', i)) return;
    const isImage = col<boolean>('isImage', i) !== false;
    out.push({
      id,
      isVideo: !isImage,
      ratio: Number(col<number>('ratio', i)) || 0,
      durationMs: parseDuration(col('duration', i)),
      takenLocal: localTaken(String(col('fileCreatedAt', i) ?? ''), Number(col('localOffsetHours', i))),
      uploadedAt: Date.parse(String(col('createdAt', i) ?? '')) || 0,
      city: col<string | null>('city', i) ?? '',
      country: col<string | null>('country', i) ?? '',
      version: col<string | null>('thumbhash', i) ?? null,
    });
  });
  return out;
}

// ── Loading, with per-month reuse ───────────────────────────────────────────

/** What a previous load learned, so a refresh only asks for months whose
 *  count changed. Kept per share link. */
export interface AlbumState {
  info: LinkInfo;
  buckets: Map<string, { count: number; assets: Asset[] }>;
  /** A full re-read now and then catches a photo swapped for another within
   *  the same month, which leaves the count unchanged. */
  fullAt: number;
}

export const FULL_RELOAD_MS = 60 * 60_000;

export async function loadAlbum(
  fetch: Fetcher,
  link: ShareLink,
  prev: AlbumState | null,
  now = Date.now(),
): Promise<{ state: AlbumState; assets: Asset[] }> {
  const api = `${link.origin}/api`;
  const info = parseLinkInfo(await getJson(fetch, `${api}/shared-links/me?${link.auth}`));
  if (!info.albumId) {
    const state: AlbumState = { info, buckets: new Map(), fullAt: now };
    return { state, assets: info.assets ?? [] };
  }
  const album = `albumId=${info.albumId}&${link.auth}`;
  const list = parseBuckets(await getJson(fetch, `${api}/timeline/buckets?${album}`));
  const full = !prev || prev.info.albumId !== info.albumId || now - prev.fullAt >= FULL_RELOAD_MS;
  const buckets = new Map<string, { count: number; assets: Asset[] }>();
  for (const { timeBucket, count } of list) {
    const known = full ? undefined : prev?.buckets.get(timeBucket);
    if (known && known.count === count) {
      buckets.set(timeBucket, known);
      continue;
    }
    const body = await getJson(fetch, `${api}/timeline/bucket?${album}&timeBucket=${encodeURIComponent(timeBucket)}`);
    buckets.set(timeBucket, { count, assets: parseBucket(body) });
  }
  const state: AlbumState = { info, buckets, fullAt: full ? now : prev!.fullAt };
  return { state, assets: [...buckets.values()].flatMap((b) => b.assets) };
}
