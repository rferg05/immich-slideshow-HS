import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { PluginComponentProps } from './hs-plugin';
import { hostFrameStyle } from './host-style';
import { readConfig } from './config';
import type { Config } from './config';
import { leavesBars, objectFit } from './fit';
import { Playlist } from './playlist';
import { hostFetcher, ImmichError, imageUrl, loadAlbum, parseShareLink, PLUGIN_ID, sizeFor, videoUrl } from './immich';
import type { AlbumState, Asset, Failure, Fetcher, ShareLink } from './immich';

/** A photo or video that hasn't loaded by then is skipped. */
const LOAD_TIMEOUT_MS = 20_000;
/** After this many failures in a row the module says so, and tries again slowly. */
const STALL_AFTER = 5;
const STALL_RETRY_MS = 30_000;
/** A failed album refresh is tried again sooner than a good one is repeated. */
const RETRY_MS = 30_000;

// ── Album sessions ──────────────────────────────────────────────────────────
// Kept outside React so a module that unmounts when its screen rotates away
// picks up where it was (same pass, no re-listing) when it comes back.

interface Session {
  state: AlbumState | null;
  assets: Asset[];
  albumName: string;
  playlist: Playlist;
  failure: Failure | null;
  loadedAt: number;
  loading: Promise<void> | null;
}

const sessions = new Map<string, Session>();

function sessionFor(link: ShareLink, cfg: Config): Session {
  const id = `${link.origin}?${link.auth}`;
  let s = sessions.get(id);
  if (!s) {
    s = { state: null, assets: [], albumName: '', playlist: new Playlist(cfg.order), failure: null, loadedAt: 0, loading: null };
    sessions.set(id, s);
  }
  s.playlist.setOrder(cfg.order);
  return s;
}

const playable = (assets: Asset[], cfg: Config) => (cfg.videos ? assets : assets.filter((a) => !a.isVideo));

function log(level: 'info' | 'warn' | 'error', message: string) {
  try {
    window.__HS_SDK__?.emit?.({ type: 'log', level, message: `[${PLUGIN_ID}] ${message}` });
  } catch { /* logging is best effort */ }
}

/** Loads the album now if it's due, then keeps it fresh. Returns a counter
 *  that changes whenever the session does. */
function useAlbum(link: ShareLink | null, cfg: Config, fetcher: Fetcher): [Session | null, number] {
  const [tick, setTick] = useState(0);
  const session = useMemo(() => (link ? sessionFor(link, cfg) : null), [link?.origin, link?.auth, cfg.order]);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  useEffect(() => {
    if (!session || !link) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshMs = cfg.refreshMinutes * 60_000;

    const run = async () => {
      if (!session.loading) {
        session.loading = (async () => {
          try {
            const { state, assets } = await loadAlbum(fetcher, link, session.state);
            session.state = state;
            session.assets = assets;
            session.albumName = state.info.albumName;
            if (session.failure) log('info', 'Immich is answering again');
            session.failure = null;
            session.playlist.update(playable(assets, cfgRef.current), cfgRef.current.newFirst);
          } catch (e) {
            const failure: Failure = e instanceof ImmichError ? e.failure : { kind: 'unreachable' };
            if (session.failure?.kind !== failure.kind) log('warn', `Album refresh failed: ${failure.kind}`);
            session.failure = failure;
          } finally {
            session.loadedAt = Date.now();
            session.loading = null;
          }
        })();
      }
      await session.loading;
      if (!alive) return;
      setTick((t) => t + 1);
      timer = setTimeout(run, session.failure ? Math.min(RETRY_MS, refreshMs) : refreshMs);
    };

    const due = session.loadedAt + (session.failure ? RETRY_MS : refreshMs) - Date.now();
    if (due <= 0 || !session.state) void run();
    else timer = setTimeout(run, due);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [session, fetcher, cfg.refreshMinutes]);

  // Turning videos on or off re-filters what's already listed.
  useEffect(() => {
    if (session?.state) {
      session.playlist.update(playable(session.assets, cfg), cfg.newFirst);
      setTick((t) => t + 1);
    }
  }, [session, cfg.videos]);

  return [session, tick];
}

// ── Box size ────────────────────────────────────────────────────────────────

function useBoxSize(): [React.RefObject<HTMLDivElement | null>, { w: number; h: number }] {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // Layout size, not on-screen size: the editor scales the canvas down
      // with a transform, and the fit must match the module's real shape.
      const w = el.clientWidth;
      const h = el.clientHeight;
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

// ── Slides ──────────────────────────────────────────────────────────────────

type Phase = 'loading' | 'shown' | 'leaving';

interface Layer {
  key: number;
  asset: Asset;
  phase: Phase;
  /** Leaving under a slide that covers the whole box: stays opaque until
   *  removed, so a crossfade doesn't dip toward the background halfway. */
  hold?: boolean;
}

const KEYFRAMES = `
@keyframes ims-zoom { from { transform: scale(1); } to { transform: scale(1.08); } }
@keyframes ims-caption { from { opacity: 0; } to { opacity: 1; } }
`;

/** Each photo zooms toward a different corner, picked from its id. */
function zoomOrigin(id: string): string {
  const n = parseInt(id.replace(/[^0-9a-f]/gi, '').slice(-2) || '0', 16);
  return ['20% 30%', '80% 30%', '30% 75%', '70% 70%', '50% 40%'][n % 5];
}

function layerStyle(phase: Phase, cfg: Config, hold: boolean): CSSProperties {
  const ms = cfg.transition === 'none' ? 0 : cfg.transitionSeconds * 1000;
  const base: CSSProperties = { position: 'absolute', inset: 0, overflow: 'hidden' };
  if (cfg.transition === 'slide') {
    const x = phase === 'loading' ? '100%' : phase === 'leaving' ? '-100%' : '0';
    return { ...base, transform: `translateX(${x})`, transition: `transform ${ms}ms ease-in-out` };
  }
  return { ...base, opacity: phase === 'shown' || (phase === 'leaving' && hold) ? 1 : 0, transition: `opacity ${ms}ms ease-in-out` };
}

interface LayerProps {
  layer: Layer;
  link: ShareLink;
  cfg: Config;
  box: { w: number; h: number };
  onReady: (key: number, ratio: number) => void;
  onFail: (key: number) => void;
  onEnded: (key: number) => void;
}

function LayerView({ layer, link, cfg, box, onReady, onFail, onEnded }: LayerProps) {
  const { asset, phase, key } = layer;
  const [ratio, setRatio] = useState(asset.ratio);
  const videoRef = useRef<HTMLVideoElement>(null);
  const settled = useRef(false);

  const ready = (r: number) => {
    if (settled.current) return;
    settled.current = true;
    if (r > 0) setRatio(r);
    onReady(key, r);
  };
  const fail = () => {
    if (settled.current) return;
    settled.current = true;
    onFail(key);
  };

  useEffect(() => {
    const t = setTimeout(fail, LOAD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || phase !== 'shown') return;
    v.currentTime = 0;
    v.play().catch(() => {
      // Browsers refuse to autoplay with sound until someone has interacted
      // with the page; play muted rather than not at all.
      v.muted = true;
      v.play().catch(() => onEnded(key));
    });
  }, [phase]);

  const fit = objectFit(cfg.fit, box.w, box.h, ratio, cfg.maxCrop);
  const backdrop = cfg.backdrop === 'blur' && fit === 'contain' && leavesBars(box.w, box.h, ratio || 1);
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const size = sizeFor(Math.max(box.w, box.h) * dpr);
  const media: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: fit, display: 'block' };
  const zoom = cfg.slowZoom && !asset.isVideo && phase !== 'loading';

  return (
    <div style={layerStyle(phase, cfg, !!layer.hold)} aria-hidden={phase !== 'shown'}>
      {backdrop && (
        <img
          src={imageUrl(link, asset.id, 'thumbnail', asset.version)}
          alt=""
          style={{
            ...media,
            objectFit: 'cover',
            filter: 'blur(28px) brightness(0.6)',
            transform: 'scale(1.15)',
          }}
        />
      )}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          transformOrigin: zoomOrigin(asset.id),
          animation: zoom ? `ims-zoom ${cfg.intervalSeconds + cfg.transitionSeconds * 2}s linear forwards` : undefined,
        }}
      >
        {asset.isVideo ? (
          <video
            ref={videoRef}
            src={videoUrl(link, asset.id)}
            poster={imageUrl(link, asset.id, size, asset.version)}
            muted={!cfg.videoSound}
            playsInline
            preload="auto"
            style={media}
            onLoadedData={(e) => ready(e.currentTarget.videoWidth / (e.currentTarget.videoHeight || 1))}
            onError={fail}
            onEnded={() => onEnded(key)}
          />
        ) : (
          <img
            src={imageUrl(link, asset.id, size, asset.version)}
            alt=""
            decoding="async"
            style={media}
            onLoad={(e) => {
              const img = e.currentTarget;
              const r = img.naturalWidth / (img.naturalHeight || 1);
              // Wait for the decode so the fade never starts on a blank frame.
              (img.decode ? img.decode() : Promise.resolve()).then(() => ready(r), () => ready(r));
            }}
            onError={fail}
          />
        )}
      </div>
    </div>
  );
}

// ── Caption ─────────────────────────────────────────────────────────────────

function formatTaken(takenLocal: string, locale: string | undefined): string {
  const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(takenLocal);
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  try {
    return new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** The country most of the album was taken in; left off captions as obvious. */
function homeCountry(assets: Asset[]): string {
  const counts = new Map<string, number>();
  for (const a of assets) if (a.country) counts.set(a.country, (counts.get(a.country) ?? 0) + 1);
  let best = '';
  let most = 0;
  for (const [c, n] of counts) if (n > most) [best, most] = [c, n];
  return best;
}

function captionText(asset: Asset, cfg: Config, home: string): string {
  const parts: string[] = [];
  if (cfg.caption === 'both' || cfg.caption === 'place') {
    const country = asset.country && asset.country !== home ? asset.country : '';
    const place = [asset.city, country].filter(Boolean).join(', ') || country;
    if (place) parts.push(place);
  }
  if (cfg.caption === 'both' || cfg.caption === 'date') {
    const date = formatTaken(asset.takenLocal, window.__HS_SDK__?.locale);
    if (date) parts.push(date);
  }
  return parts.join(' · ');
}

function Caption({ text, cfg, assetId }: { text: string; cfg: Config; assetId: string }) {
  const [v, hz] = cfg.captionPosition.split('-') as ['top' | 'bottom', 'left' | 'right'];
  return (
    <div
      key={assetId}
      style={{
        position: 'absolute',
        [v]: 0,
        left: 0,
        right: 0,
        padding: v === 'bottom' ? '2.2em 0.9em 0.7em' : '0.7em 0.9em 2.2em',
        textAlign: hz,
        fontSize: '0.95em',
        fontWeight: 500,
        lineHeight: 1.3,
        color: '#fff',
        textShadow: '0 1px 3px rgba(0,0,0,0.8)',
        background: `linear-gradient(to ${v === 'bottom' ? 'top' : 'bottom'}, rgba(0,0,0,0.45), rgba(0,0,0,0))`,
        pointerEvents: 'none',
        animation: 'ims-caption 600ms ease-out',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {text}
    </div>
  );
}

// ── Notices ─────────────────────────────────────────────────────────────────

function Notice({ title, detail, delayed }: { title: string; detail?: string; delayed?: boolean }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '1em',
        gap: '0.4em',
        // Only shown if the wait is noticeable, so a quick load doesn't flash it.
        animation: delayed ? 'ims-caption 400ms ease-out 2s both' : undefined,
      }}
    >
      <div style={{ fontSize: '1.05em', fontWeight: 600 }}>{title}</div>
      {detail && <div style={{ fontSize: '0.85em', opacity: 0.75, maxWidth: '32em' }}>{detail}</div>}
    </div>
  );
}

function failureNotice(f: Failure, link: ShareLink): { title: string; detail?: string } {
  switch (f.kind) {
    case 'unreachable':
      return { title: `Can't reach Immich at ${link.origin}`, detail: 'Check that Immich is running and that the address in the share link is right.' };
    case 'proxy':
      return { title: 'Home Screens blocked the request to Immich', detail: f.message };
    case 'linkGone':
      return { title: "Immich doesn't recognize this share link", detail: 'It may have expired or been deleted. Make a new one from the album in Immich.' };
    case 'password':
      return { title: 'This share link has a password', detail: 'Make a share link without a password for the dashboard.' };
    default:
      return { title: `Immich answered with an error (${f.status})` };
  }
}

// ── Slideshow ───────────────────────────────────────────────────────────────

function Slideshow({ link, session, cfg, box, tick }: { link: ShareLink; session: Session; cfg: Config; box: { w: number; h: number }; tick: number }) {
  const [layers, setLayers] = useState<Layer[]>([]);
  const [stalled, setStalled] = useState(false);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const started = useRef(false);
  const failures = useRef(0);
  const byKey = useRef(new Map<number, Asset>());
  const shown = useRef<{ key: number; asset: Asset } | null>(null);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const boxRef = useRef(box);
  boxRef.current = box;

  const schedule = useCallback((ms: number, fn: () => void) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  }, []);

  const advance = useCallback(() => {
    const asset = session.playlist.next();
    if (!asset) return;
    // A one-photo album: nothing to change to.
    if (asset.id === shown.current?.asset.id && !asset.isVideo && session.playlist.size === 1) {
      schedule(cfgRef.current.intervalSeconds * 1000, advance);
      return;
    }
    const key = ++seq.current;
    byKey.current.set(key, asset);
    setLayers((ls) => [...ls.filter((l) => l.phase !== 'loading'), { key, asset, phase: 'loading' }]);
  }, [session, schedule]);

  const onReady = useCallback((key: number) => {
    const asset = byKey.current.get(key);
    if (!asset) return;
    const c = cfgRef.current;
    failures.current = 0;
    setStalled(false);
    shown.current = { key, asset };
    const b = boxRef.current;
    const covers = c.backdrop === 'blur' || objectFit(c.fit, b.w, b.h, asset.ratio, c.maxCrop) === 'cover';
    setLayers((ls) => ls.map((l) => (l.key === key ? { ...l, phase: 'shown' } : l.phase === 'shown' ? { ...l, phase: 'leaving', hold: covers } : l)));
    const transitionMs = c.transition === 'none' ? 0 : c.transitionSeconds * 1000;
    setTimeout(() => {
      setLayers((ls) => {
        const kept = ls.filter((l) => l.phase !== 'leaving');
        for (const k of byKey.current.keys()) if (!kept.some((l) => l.key === k)) byKey.current.delete(k);
        return kept;
      });
    }, transitionMs + 150);
    // Videos advance when they end; this is the cap on a long one.
    schedule(asset.isVideo ? c.maxVideoSeconds * 1000 : c.intervalSeconds * 1000 + transitionMs, advance);
    // Warm the browser cache for the next photo while this one shows.
    const next = session.playlist.peek();
    if (next && !next.isVideo) {
      const img = new Image();
      img.src = imageUrl(link, next.id, sizeFor(Math.max(b.w, b.h) * (window.devicePixelRatio || 1)), next.version);
    }
  }, [advance, schedule, session, link]);

  const onFail = useCallback((key: number) => {
    const asset = byKey.current.get(key);
    byKey.current.delete(key);
    setLayers((ls) => ls.filter((l) => l.key !== key));
    if (asset) log('warn', `Couldn't load ${asset.isVideo ? 'video' : 'photo'} ${asset.id}`);
    failures.current += 1;
    if (failures.current >= Math.min(STALL_AFTER, Math.max(1, session.playlist.size))) {
      failures.current = 0;
      setStalled(true);
      schedule(STALL_RETRY_MS, advance);
    } else {
      schedule(300, advance);
    }
  }, [advance, schedule, session]);

  const onEnded = useCallback((key: number) => {
    if (shown.current?.key === key) schedule(0, advance);
  }, [advance, schedule]);

  // Start once there's something to show; stop if the album empties.
  useEffect(() => {
    if (session.playlist.size === 0) {
      clearTimeout(timer.current);
      started.current = false;
      shown.current = null;
      setLayers([]);
    } else if (!started.current) {
      started.current = true;
      advance();
    }
  }, [tick, session, advance]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const current = [...layers].reverse().find((l) => l.phase === 'shown');
  const home = useMemo(() => homeCountry(session.assets), [session.assets]);
  const caption = current && cfg.caption !== 'none' ? captionText(current.asset, cfg, home) : '';

  return (
    <>
      {layers.map((l) => (
        <LayerView key={l.key} layer={l} link={link} cfg={cfg} box={box} onReady={onReady} onFail={onFail} onEnded={onEnded} />
      ))}
      {caption && current && <Caption text={caption} cfg={cfg} assetId={current.asset.id} />}
      {stalled && !current && (
        <Notice title={`Photos aren't loading from ${link.origin}`} detail="Trying again shortly." />
      )}
    </>
  );
}

// ── Module ──────────────────────────────────────────────────────────────────

export default function ImmichSlideshow(props: PluginComponentProps & { fetcher?: Fetcher }) {
  const { style } = props;
  const cfg = useMemo(() => readConfig(props.config ?? {}), [props.config]);
  const parsed = useMemo(() => parseShareLink(cfg.shareLink), [cfg.shareLink]);
  const link = typeof parsed === 'string' ? null : parsed;
  const fetcher = useMemo(() => props.fetcher ?? hostFetcher(), [props.fetcher]);
  const [session, tick] = useAlbum(link, cfg, fetcher);
  const [boxRef, box] = useBoxSize();

  const radius = Math.max(0, (Number(style.borderRadius) || 0) - (Number(style.padding) || 0));

  let notice: { title: string; detail?: string; delayed?: boolean } | null = null;
  if (typeof parsed === 'string') {
    notice = parsed === 'empty'
      ? { title: 'Add an Immich album', detail: "Paste the album's share link into this module's settings." }
      : { title: "That isn't an Immich share link", detail: 'It should look like http://192.168.1.50:2283/share/AbC123…' };
  } else if (session && link) {
    if (!session.state && session.failure) notice = failureNotice(session.failure, link);
    else if (!session.state) notice = { title: 'Loading album…', delayed: true };
    else if (session.playlist.size === 0) {
      notice = {
        title: session.albumName ? `No photos in “${session.albumName}” yet` : 'No photos in this album yet',
        detail: session.assets.length && !cfg.videos ? 'It only has videos, and videos are turned off.' : 'Add some from the Immich app on your phone.',
      };
    }
  }

  return (
    <div style={{ ...hostFrameStyle(style, { baseFontSize: 16 }) }}>
      <style>{KEYFRAMES}</style>
      <div ref={boxRef} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', borderRadius: radius }}>
        {link && session && !notice && box.w > 0 && (
          <Slideshow link={link} session={session} cfg={cfg} box={box} tick={tick} />
        )}
        {notice && <Notice {...notice} />}
      </div>
    </div>
  );
}
