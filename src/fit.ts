// How a photo or video sits in the module's box. The box is measured live,
// so this is re-decided whenever the module is resized or the screen layout
// changes, and every photo is scaled to the box it is actually in.

export type FitMode = 'smart' | 'contain' | 'cover';

/** How much of the photo filling the box would cut off, 0..1. A 4:3 photo in
 *  a 16:9 box loses 25% of its height. */
export function cropFraction(boxW: number, boxH: number, ratio: number): number {
  if (!(boxW > 0 && boxH > 0 && ratio > 0)) return 0;
  const box = boxW / boxH;
  return 1 - Math.min(box, ratio) / Math.max(box, ratio);
}

/** `contain` shows the whole photo with bars; `cover` fills the box and crops.
 *  `smart` fills unless that would crop more than `maxCropPct` percent: a
 *  landscape photo fills a landscape box, a portrait one is shown whole. */
export function objectFit(
  mode: FitMode,
  boxW: number,
  boxH: number,
  ratio: number,
  maxCropPct: number,
): 'contain' | 'cover' {
  if (mode !== 'smart') return mode;
  if (!(ratio > 0) || !(boxW > 0 && boxH > 0)) return 'contain';
  return cropFraction(boxW, boxH, ratio) <= maxCropPct / 100 ? 'cover' : 'contain';
}

/** Whether a photo shown whole leaves bars worth filling with a backdrop. */
export function leavesBars(boxW: number, boxH: number, ratio: number): boolean {
  return cropFraction(boxW, boxH, ratio) > 0.01;
}
