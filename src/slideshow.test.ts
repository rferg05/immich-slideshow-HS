import { describe, expect, it } from 'vitest';
import { cropFraction, leavesBars, objectFit } from './fit';
import {
  imageUrl, loadAlbum, originalUrl, localTaken, parseBucket, parseBuckets, parseDuration, parseLinkInfo, parseShareLink, sizeFor, videoUrl,
} from './immich';
import type { Asset, Fetcher, ShareLink } from './immich';
import { ordered, Playlist } from './playlist';
import { readConfig } from './config';

const link = (s: string) => parseShareLink(s) as ShareLink;

describe('share links', () => {
  it('reads the key from a /share/ link', () => {
    expect(parseShareLink('http://192.168.1.50:2283/share/AbC-123_x')).toEqual({ origin: 'http://192.168.1.50:2283', auth: 'key=AbC-123_x' });
  });
  it('reads a custom /s/ slug', () => {
    expect(parseShareLink('http://photos.lan:2283/s/dashboard')).toEqual({ origin: 'http://photos.lan:2283', auth: 'slug=dashboard' });
  });
  it('accepts a link pasted without http://, or with a photo open', () => {
    expect(parseShareLink(' 192.168.1.50:2283/share/k1/photos/abc ')).toEqual({ origin: 'http://192.168.1.50:2283', auth: 'key=k1' });
  });
  it('explains what is wrong with other text', () => {
    expect(parseShareLink('')).toBe('empty');
    expect(parseShareLink('http://192.168.1.50:2283/albums/123')).toBe('notAShare');
    expect(parseShareLink('http://exa mple')).toBe('notALink');
  });
  it('builds media URLs that carry the key', () => {
    const l = link('http://pi:2283/share/k1');
    expect(imageUrl(l, 'a1', 'preview', 'th+1')).toBe('http://pi:2283/api/assets/a1/thumbnail?size=preview&key=k1&c=th%2B1');
    expect(videoUrl(l, 'a1')).toBe('http://pi:2283/api/assets/a1/video/playback?key=k1');
    expect(originalUrl(l, 'a1')).toBe('http://pi:2283/api/assets/a1/original?key=k1');
  });
  it('uses the small thumbnail only for small modules', () => {
    expect(sizeFor(200)).toBe('thumbnail');
    expect(sizeFor(251)).toBe('preview');
    expect(sizeFor(3840)).toBe('preview');
  });
});

describe('fitting the box', () => {
  it('measures how much filling would crop', () => {
    expect(cropFraction(1600, 900, 4 / 3)).toBeCloseTo(0.25);
    expect(cropFraction(900, 1600, 3 / 4)).toBeCloseTo(0.25);
    expect(cropFraction(1600, 900, 16 / 9)).toBeCloseTo(0);
  });
  it('fills only when the crop is small enough', () => {
    expect(objectFit('smart', 1600, 900, 16 / 9, 20)).toBe('cover');
    expect(objectFit('smart', 1600, 900, 4 / 3, 20)).toBe('contain');
    expect(objectFit('smart', 1600, 900, 4 / 3, 25)).toBe('cover');
    expect(objectFit('smart', 1600, 900, 3 / 4, 20)).toBe('contain');
  });
  it('re-decides when the module changes shape', () => {
    // The same portrait photo: shown whole in a wide box, filling a tall one.
    expect(objectFit('smart', 1920, 1080, 3 / 4, 20)).toBe('contain');
    expect(objectFit('smart', 600, 800, 3 / 4, 20)).toBe('cover');
  });
  it('honors the fixed modes and unknown shapes', () => {
    expect(objectFit('cover', 100, 100, 3, 0)).toBe('cover');
    expect(objectFit('contain', 100, 100, 1, 0)).toBe('contain');
    expect(objectFit('smart', 100, 100, 0, 20)).toBe('contain');
    expect(leavesBars(100, 100, 1)).toBe(false);
    expect(leavesBars(160, 90, 1)).toBe(true);
  });
});

describe('Immich responses', () => {
  it('reads an album link', () => {
    expect(parseLinkInfo({ type: 'ALBUM', album: { id: 'al1', albumName: 'Dashboard' }, assets: [] }))
      .toEqual({ albumId: 'al1', albumName: 'Dashboard', assets: null });
  });
  it('reads a link to hand-picked photos', () => {
    const info = parseLinkInfo({
      type: 'INDIVIDUAL',
      assets: [
        { id: 'p1', type: 'IMAGE', width: 4032, height: 3024, duration: null, localDateTime: '2026-07-04T18:30:00.000Z', createdAt: '2026-07-05T00:00:00.000Z', isTrashed: false, thumbhash: 'x', exifInfo: { city: 'Chicago', country: 'United States of America' } },
        { id: 'v1', type: 'VIDEO', width: 1920, height: 1080, duration: '0:00:12.500', localDateTime: '2026-07-04T18:31:00.000Z', createdAt: '2026-07-05T00:00:00.000Z', isTrashed: false, thumbhash: null },
        { id: 't1', type: 'IMAGE', isTrashed: true },
      ],
    });
    expect(info.albumId).toBeNull();
    expect(info.assets!.map((a) => [a.id, a.isVideo, a.durationMs, a.takenLocal])).toEqual([
      ['p1', false, 0, '2026-07-04T18:30:00'],
      ['v1', true, 12500, '2026-07-04T18:31:00'],
    ]);
    expect(info.assets![0].ratio).toBeCloseTo(4 / 3);
  });
  it('reads bucket lists', () => {
    expect(parseBuckets([{ timeBucket: '2026-07-01', count: 3 }, { count: 2 }])).toEqual([{ timeBucket: '2026-07-01', count: 3 }]);
    expect(parseBuckets({ error: 'x' })).toEqual([]);
  });
  it('reads one bucket of parallel arrays, skipping trash', () => {
    const assets = parseBucket({
      id: ['a', 'b', 'c'],
      isImage: [true, false, true],
      isTrashed: [false, false, true],
      ratio: [0.75, 1.7778, 1],
      duration: [null, 8000, null],
      fileCreatedAt: ['2026-07-04T23:30:00.000Z', '2026-07-05T01:00:00.000Z', '2026-07-05T01:00:00.000Z'],
      localOffsetHours: [-5, -5, 0],
      createdAt: ['2026-07-05T02:00:00.000Z', '2026-07-05T03:00:00.000Z', '2026-07-05T03:00:00.000Z'],
      city: ['Chicago', null, null],
      country: ['United States of America', null, null],
      thumbhash: ['h1', null, null],
    });
    expect(assets).toHaveLength(2);
    expect(assets[0]).toMatchObject({ id: 'a', isVideo: false, ratio: 0.75, takenLocal: '2026-07-04T18:30:00', city: 'Chicago', version: 'h1' });
    expect(assets[1]).toMatchObject({ id: 'b', isVideo: true, durationMs: 8000, takenLocal: '2026-07-04T20:00:00', city: '' });
  });
  it('tells animated GIFs from still photos by their duration', () => {
    const [still, gif, video] = parseBucket({
      id: ['s', 'g', 'v'],
      isImage: [true, true, false],
      duration: [null, 2400, 8000],
      ratio: [1, 1, 1],
    });
    expect([still.isAnimated, gif.isAnimated, video.isAnimated]).toEqual([false, true, false]);
    expect(gif).toMatchObject({ isVideo: false, durationMs: 2400 });
    const dto = parseLinkInfo({ type: 'INDIVIDUAL', assets: [
      { id: 'g', type: 'IMAGE', duration: '0:00:02.400', width: 10, height: 10 },
      { id: 's', type: 'IMAGE', duration: '0:00:00.00000', width: 10, height: 10 },
    ] }).assets!;
    expect(dto.map((a) => a.isAnimated)).toEqual([true, false]);
  });
  it('reads both duration formats', () => {
    expect(parseDuration(1500)).toBe(1500);
    expect(parseDuration('0:01:02.250')).toBe(62250);
    expect(parseDuration(null)).toBe(0);
  });
  it('turns UTC plus offset into wall-clock time', () => {
    expect(localTaken('2026-01-01T03:00:00.000Z', 5.5)).toBe('2026-01-01T08:30:00');
    expect(localTaken('nope', 0)).toBe('');
  });
});

describe('loading an album', () => {
  const bucketBody = (ids: string[]) => ({
    id: ids, isImage: ids.map(() => true), ratio: ids.map(() => 1.5), duration: ids.map(() => null),
    fileCreatedAt: ids.map(() => '2026-07-01T00:00:00.000Z'), localOffsetHours: ids.map(() => 0),
    createdAt: ids.map(() => '2026-07-01T00:00:00.000Z'), city: ids.map(() => null), country: ids.map(() => null),
    isTrashed: ids.map(() => false), thumbhash: ids.map(() => null),
  });

  function fakeImmich(months: Record<string, string[]>) {
    const calls: string[] = [];
    const fetch: Fetcher = async ({ url }) => {
      const u = new URL(url);
      calls.push(u.pathname + (u.searchParams.get('timeBucket') ? `:${u.searchParams.get('timeBucket')}` : ''));
      if (u.searchParams.get('key') !== 'k1') return { status: 401, body: { message: 'Invalid share key' } };
      if (u.pathname === '/api/shared-links/me') return { status: 200, body: { type: 'ALBUM', album: { id: 'al1', albumName: 'Dash' } } };
      if (u.pathname === '/api/timeline/buckets') {
        return { status: 200, body: Object.entries(months).map(([timeBucket, ids]) => ({ timeBucket, count: ids.length })) };
      }
      if (u.pathname === '/api/timeline/bucket') return { status: 200, body: bucketBody(months[u.searchParams.get('timeBucket')!] ?? []) };
      return { status: 404, body: {} };
    };
    return { fetch, calls };
  }

  it('lists every month, then only months whose count changed', async () => {
    const months = { '2026-07-01': ['a', 'b'], '2026-08-01': ['c'] };
    const { fetch, calls } = fakeImmich(months);
    const l = link('http://pi:2283/share/k1');
    const first = await loadAlbum(fetch, l, null, 1000);
    expect(first.assets.map((a) => a.id)).toEqual(['a', 'b', 'c']);
    expect(calls).toEqual(['/api/shared-links/me', '/api/timeline/buckets', '/api/timeline/bucket:2026-07-01', '/api/timeline/bucket:2026-08-01']);

    calls.length = 0;
    months['2026-08-01'] = ['c', 'd'];
    const second = await loadAlbum(fetch, l, first.state, 2000);
    expect(second.assets.map((a) => a.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(calls).toEqual(['/api/shared-links/me', '/api/timeline/buckets', '/api/timeline/bucket:2026-08-01']);
  });

  it('re-reads everything once an hour', async () => {
    const { fetch, calls } = fakeImmich({ '2026-07-01': ['a'] });
    const l = link('http://pi:2283/share/k1');
    const first = await loadAlbum(fetch, l, null, 0);
    calls.length = 0;
    await loadAlbum(fetch, l, first.state, 61 * 60_000);
    expect(calls).toContain('/api/timeline/bucket:2026-07-01');
  });

  it('says when the link is no good', async () => {
    const { fetch } = fakeImmich({});
    await expect(loadAlbum(fetch, link('http://pi:2283/share/wrong'), null)).rejects.toMatchObject({ failure: { kind: 'linkGone' } });
  });

  it('tells a proxy refusal and an unreachable server apart', async () => {
    const l = link('http://pi:2283/share/k1');
    const refused: Fetcher = async () => ({ status: 403, body: { error: 'Upstream URL resolves to a blocked address' } });
    await expect(loadAlbum(refused, l, null)).rejects.toMatchObject({ failure: { kind: 'proxy' } });
    const down: Fetcher = async () => { throw new TypeError('Failed to fetch'); };
    await expect(loadAlbum(down, l, null)).rejects.toMatchObject({ failure: { kind: 'unreachable' } });
    const password: Fetcher = async () => ({ status: 401, body: { message: 'Invalid password' } });
    await expect(loadAlbum(password, l, null)).rejects.toMatchObject({ failure: { kind: 'password' } });
  });
});

const asset = (id: string, over: Partial<Asset> = {}): Asset => ({
  id, isVideo: false, isAnimated: false, ratio: 1.5, durationMs: 0, takenLocal: '', uploadedAt: 0, city: '', country: '', version: null, ...over,
});

describe('playlist', () => {
  const seq = (values: number[]) => { let i = 0; return () => values[i++ % values.length]; };

  it('plays every photo once per pass, in order', () => {
    const p = new Playlist('oldest');
    p.update([asset('b', { takenLocal: '2026-02-01T00:00:00' }), asset('a', { takenLocal: '2026-01-01T00:00:00' })], true);
    expect([p.next()!.id, p.next()!.id, p.next()!.id]).toEqual(['a', 'b', 'a']);
  });

  it('orders by taken date or by upload', () => {
    const list = [asset('x', { takenLocal: '2026-01-01T00:00:00', uploadedAt: 3 }), asset('y', { takenLocal: '2026-03-01T00:00:00', uploadedAt: 1 })];
    expect(ordered(list, 'newest').map((a) => a.id)).toEqual(['y', 'x']);
    expect(ordered(list, 'uploaded').map((a) => a.id)).toEqual(['x', 'y']);
  });

  it('shuffles without repeating within a pass or across the seam', () => {
    const p = new Playlist('shuffle', seq([0.1, 0.9, 0.5, 0.3, 0.7]));
    p.update(['a', 'b', 'c', 'd'].map((id) => asset(id)), true);
    const first = [1, 2, 3, 4].map(() => p.next()!.id);
    expect(new Set(first).size).toBe(4);
    expect(p.next()!.id).not.toBe(first[3]);
  });

  it('plays new uploads next, newest first, and not again later in the pass', () => {
    const p = new Playlist('oldest');
    const base = [asset('a', { takenLocal: '1' }), asset('b', { takenLocal: '2' }), asset('c', { takenLocal: '3' })];
    p.update(base, true);
    expect(p.next()!.id).toBe('a');
    p.update([...base, asset('n1', { uploadedAt: 10, takenLocal: '0' }), asset('n2', { uploadedAt: 20, takenLocal: '0' })], true);
    expect(p.peek()!.id).toBe('n2');
    expect([p.next()!.id, p.next()!.id, p.next()!.id, p.next()!.id]).toEqual(['n2', 'n1', 'b', 'c']);
  });

  it('drops removed photos and empties cleanly', () => {
    const p = new Playlist('oldest');
    p.update([asset('a', { takenLocal: '1' }), asset('b', { takenLocal: '2' })], true);
    p.update([asset('b', { takenLocal: '2' })], true);
    expect(p.next()!.id).toBe('b');
    p.update([], true);
    expect(p.next()).toBeNull();
    expect(p.size).toBe(0);
  });
});

describe('config', () => {
  it('fills defaults and clamps', () => {
    const c = readConfig({ intervalSeconds: '1', order: 'bogus', maxCrop: 99, videos: 'false' });
    expect(c).toMatchObject({ intervalSeconds: 3, order: 'shuffle', maxCrop: 60, videos: false, animated: true, fit: 'smart', caption: 'both' });
  });
});
