/** Seeded randomness so every run of a seed is the same world. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)];
  }
  /** Picks a key of `weights` with probability proportional to its weight. */
  weighted<K extends string>(weights: Record<K, number>): K {
    const total = Object.values<number>(weights).reduce((a, b) => a + b, 0);
    let r = this.next() * total;
    for (const [k, w] of Object.entries<number>(weights)) {
      r -= w;
      if (r < 0) return k as K;
    }
    return Object.keys(weights)[0] as K;
  }
  fork(salt: number): Rng {
    return new Rng((Math.floor(this.next() * 2 ** 31) ^ salt) >>> 0);
  }
}
