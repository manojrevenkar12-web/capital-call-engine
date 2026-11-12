/**
 * Money is an integer number of cents. Splitting money is done with BigInt so that
 * commitment x amount products never lose precision, and every split sums back to
 * the amount it came from.
 */

export type Cents = number;

export function cents(value: number | bigint): Cents {
  const n = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(n)) throw new Error(`not a whole number of cents: ${value}`);
  return n;
}

export function sum(values: Iterable<Cents>): Cents {
  let total = 0;
  for (const v of values) total += v;
  return cents(total);
}

/**
 * Largest-remainder split of `total` across `weights`. Each share is floor(total x w / W);
 * the cents left over go one each to the largest remainders, ties broken by key so the
 * result never depends on input order. The shares always sum to `total`.
 */
export function allocate(total: Cents, weights: ReadonlyMap<string, bigint | number>): Map<string, Cents> {
  const out = new Map<string, Cents>();
  const keys = [...weights.keys()].sort();
  if (keys.length === 0) {
    if (total !== 0) throw new Error("cannot allocate a non-zero amount across nobody");
    return out;
  }
  const sign = total < 0 ? -1n : 1n;
  const t = BigInt(Math.abs(total));
  let w = 0n;
  for (const k of keys) {
    const v = BigInt(weights.get(k)!);
    if (v < 0n) throw new Error(`negative weight for ${k}`);
    w += v;
  }
  if (w === 0n) throw new Error("all weights are zero");
  const rems: { key: string; rem: bigint }[] = [];
  let given = 0n;
  for (const k of keys) {
    const p = t * BigInt(weights.get(k)!);
    const share = p / w;
    given += share;
    out.set(k, Number(share * sign));
    rems.push({ key: k, rem: p % w });
  }
  let left = t - given;
  rems.sort((a, b) => (a.rem === b.rem ? (a.key < b.key ? -1 : 1) : a.rem > b.rem ? -1 : 1));
  for (const r of rems) {
    if (left === 0n) break;
    out.set(r.key, out.get(r.key)! + Number(sign));
    left -= 1n;
  }
  return out;
}

/** Exact fractions for interest and preferred return, rounded to cents only when paid. */
export class Q {
  readonly n: bigint;
  readonly d: bigint;
  constructor(n: bigint, d: bigint = 1n) {
    if (d === 0n) throw new Error("zero denominator");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n < 0n ? -n : n, d);
    this.n = g > 1n ? n / g : n;
    this.d = g > 1n ? d / g : d;
  }
  static of(c: Cents | bigint): Q {
    return new Q(BigInt(c));
  }
  add(o: Q): Q {
    return new Q(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o: Q): Q {
    return new Q(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o: Q): Q {
    return new Q(this.n * o.n, this.d * o.d);
  }
  isNegative(): boolean {
    return this.n < 0n;
  }
  /** Rounded down to whole cents (towards minus infinity). */
  floor(): Cents {
    const q = this.n / this.d;
    return cents(this.n < 0n && q * this.d !== this.n ? q - 1n : q);
  }
  /** Rounded half up to whole cents. */
  round(): Cents {
    return new Q(this.n * 2n + this.d, this.d * 2n).floor();
  }
  cmp(o: Q): number {
    const l = this.n * o.d;
    const r = o.n * this.d;
    return l === r ? 0 : l < r ? -1 : 1;
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a || 1n;
}

export function eur(c: Cents): string {
  const neg = c < 0;
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}€${whole}.${String(abs % 100).padStart(2, "0")}`;
}
