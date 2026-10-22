// What plays next. Every photo plays once per pass; a refresh that finds new
// uploads can put them at the front, so something just added from a phone
// shows up within one slide.

import type { Asset } from './immich';

export type Order = 'shuffle' | 'newest' | 'oldest' | 'uploaded';

const takenKey = (a: Asset) => a.takenLocal || new Date(a.uploadedAt).toISOString();

export function ordered(assets: Asset[], order: Exclude<Order, 'shuffle'>): Asset[] {
  const list = [...assets];
  if (order === 'uploaded') return list.sort((a, b) => b.uploadedAt - a.uploadedAt);
  list.sort((a, b) => takenKey(a).localeCompare(takenKey(b)));
  return order === 'newest' ? list.reverse() : list;
}

export class Playlist {
  private byId = new Map<string, Asset>();
  /** New arrivals waiting to play ahead of the pass. */
  private priority: string[] = [];
  /** The rest of the current pass. */
  private pass: string[] = [];
  private last: string | null = null;
  private loaded = false;

  constructor(private order: Order, private random: () => number = Math.random) {}

  get size(): number {
    return this.byId.size;
  }

  setOrder(order: Order): void {
    if (order === this.order) return;
    this.order = order;
    this.pass = [];
    this.refill();
  }

  /** Replace the album contents. Assets not seen before go to the front when
   *  `newFirst` is on (never on the very first load: that's the whole album). */
  update(assets: Asset[], newFirst: boolean): void {
    const fresh = this.loaded ? assets.filter((a) => !this.byId.has(a.id)) : [];
    this.byId = new Map(assets.map((a) => [a.id, a]));
    const present = (id: string) => this.byId.has(id);
    this.priority = this.priority.filter(present);
    this.pass = this.pass.filter(present);
    if (fresh.length) {
      const newestFirst = [...fresh].sort((a, b) => b.uploadedAt - a.uploadedAt).map((a) => a.id);
      if (newFirst) this.priority.unshift(...newestFirst);
      else if (this.order === 'shuffle') {
        for (const id of newestFirst) this.pass.splice(Math.floor(this.random() * (this.pass.length + 1)), 0, id);
      }
      // Ordered passes pick new assets up when the next pass starts.
    }
    this.loaded = true;
    this.refill();
  }

  /** What `next` will return, for preloading. */
  peek(): Asset | null {
    const id = this.priority[0] ?? this.pass[0];
    return id ? this.byId.get(id) ?? null : null;
  }

  next(): Asset | null {
    const id = this.priority.shift() ?? this.pass.shift();
    if (!id) return null;
    // A new arrival that played early doesn't play again later in this pass.
    this.pass = this.pass.filter((p) => p !== id);
    this.last = id;
    this.refill();
    return this.byId.get(id) ?? null;
  }

  private refill(): void {
    if (this.pass.length || !this.byId.size) return;
    const assets = [...this.byId.values()];
    if (this.order === 'shuffle') {
      const ids = assets.map((a) => a.id);
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
      // Don't open a pass with the photo that closed the last one.
      if (ids.length > 1 && ids[0] === this.last) [ids[0], ids[1]] = [ids[1], ids[0]];
      this.pass = ids;
    } else {
      this.pass = ordered(assets, this.order).map((a) => a.id);
    }
  }
}
