import type { FitMode } from './fit';
import type { Order } from './playlist';

export type Transition = 'fade' | 'slide' | 'none';
export type Backdrop = 'blur' | 'none';
export type Caption = 'both' | 'date' | 'place' | 'none';
export type CaptionPosition = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';

export interface Config {
  shareLink: string;
  intervalSeconds: number;
  order: Order;
  newFirst: boolean;
  fit: FitMode;
  maxCrop: number;
  backdrop: Backdrop;
  transition: Transition;
  transitionSeconds: number;
  slowZoom: boolean;
  videos: boolean;
  maxVideoSeconds: number;
  videoSound: boolean;
  caption: Caption;
  captionPosition: CaptionPosition;
  refreshMinutes: number;
}

const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  options.includes(v as T) ? (v as T) : fallback;

const num = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : fallback;

export function readConfig(raw: Record<string, unknown>): Config {
  return {
    shareLink: typeof raw.shareLink === 'string' ? raw.shareLink : '',
    intervalSeconds: num(raw.intervalSeconds, 15, 3, 600),
    order: pick(raw.order, ['shuffle', 'newest', 'oldest', 'uploaded'] as const, 'shuffle'),
    newFirst: bool(raw.newFirst, true),
    fit: pick(raw.fit, ['smart', 'contain', 'cover'] as const, 'smart'),
    maxCrop: num(raw.maxCrop, 20, 0, 60),
    backdrop: pick(raw.backdrop, ['blur', 'none'] as const, 'blur'),
    transition: pick(raw.transition, ['fade', 'slide', 'none'] as const, 'fade'),
    transitionSeconds: num(raw.transitionSeconds, 1, 0.2, 5),
    slowZoom: bool(raw.slowZoom, false),
    videos: bool(raw.videos, true),
    maxVideoSeconds: num(raw.maxVideoSeconds, 60, 5, 600),
    videoSound: bool(raw.videoSound, false),
    caption: pick(raw.caption, ['both', 'date', 'place', 'none'] as const, 'both'),
    captionPosition: pick(raw.captionPosition, ['bottom-left', 'bottom-right', 'top-left', 'top-right'] as const, 'bottom-left'),
    refreshMinutes: num(raw.refreshMinutes, 2, 1, 60),
  };
}
