import { allocate, Cents, Q } from "../money/money";
import { days, IsoDate } from "./dates";

/**
 * European (whole-fund) distribution waterfall, run incrementally: each distribution
 * continues from the state the previous one left.
 *
 *   1. return of contributed capital to the investors
 *   2. preferred return: simple interest on unreturned capital, ACT/365
 *   3. GP catch-up at 100% until the GP holds `carry` of the profit paid so far
 *   4. the rest split between investors and GP
 *
 * The preferred return is accrued as an exact fraction and only rounded down to cents
 * when it is paid, so rounding never compounds across distributions.
 */

export interface WaterfallTerms {
  prefBps: number;
  carryBps: number;
}

export interface WaterfallState {
  asOf: IsoDate | null;
  capitalOutstanding: Cents;
  prefAccrued: Q;
  returnedCapital: Cents;
  prefPaid: Cents;
  catchUpPaid: Cents;
  splitToInvestors: Cents;
  splitToGp: Cents;
}

export interface Tiers {
  returnOfCapital: Cents;
  preferredReturn: Cents;
  gpCatchUp: Cents;
  splitToInvestors: Cents;
  splitToGp: Cents;
}

export function emptyWaterfall(): WaterfallState {
  return {
    asOf: null,
    capitalOutstanding: 0,
    prefAccrued: new Q(0n),
    returnedCapital: 0,
    prefPaid: 0,
    catchUpPaid: 0,
    splitToInvestors: 0,
    splitToGp: 0,
  };
}

function accrue(s: WaterfallState, to: IsoDate, t: WaterfallTerms): WaterfallState {
  if (s.asOf !== null && to < s.asOf) throw new Error(`waterfall cannot go back from ${s.asOf} to ${to}`);
  if (s.asOf === null || s.capitalOutstanding === 0) return { ...s, asOf: s.asOf === null || to > s.asOf ? to : s.asOf };
  const add = Q.of(s.capitalOutstanding)
    .mul(new Q(BigInt(t.prefBps), 10_000n))
    .mul(new Q(BigInt(days(s.asOf, to)), 365n));
  return { ...s, asOf: to, prefAccrued: s.prefAccrued.add(add) };
}

export function contribute(s: WaterfallState, date: IsoDate, amount: Cents, t: WaterfallTerms): WaterfallState {
  const a = accrue(s, date, t);
  return { ...a, capitalOutstanding: a.capitalOutstanding + amount };
}

export function distribute(
  s: WaterfallState,
  date: IsoDate,
  amount: Cents,
  t: WaterfallTerms,
): { state: WaterfallState; tiers: Tiers } {
  if (amount <= 0) throw new Error("a distribution must be positive");
  let st = accrue(s, date, t);
  let rest = amount;

  const roc = Math.min(rest, st.capitalOutstanding);
  rest -= roc;
  st = { ...st, capitalOutstanding: st.capitalOutstanding - roc, returnedCapital: st.returnedCapital + roc };

  const prefDue = st.prefAccrued.sub(Q.of(st.prefPaid)).floor();
  const pref = Math.max(0, Math.min(rest, prefDue));
  rest -= pref;
  st = { ...st, prefPaid: st.prefPaid + pref };

  // GP target: carry / (1 - carry) of the preferred return paid so far.
  const target = Q.of(st.prefPaid).mul(new Q(BigInt(t.carryBps), BigInt(10_000 - t.carryBps))).floor();
  const catchUp = Math.max(0, Math.min(rest, target - st.catchUpPaid));
  rest -= catchUp;
  st = { ...st, catchUpPaid: st.catchUpPaid + catchUp };

  let toInvestors = 0;
  let toGp = 0;
  if (rest > 0) {
    const split = allocate(rest, new Map([["gp", t.carryBps], ["lp", 10_000 - t.carryBps]]));
    toInvestors = split.get("lp")!;
    toGp = split.get("gp")!;
  }
  st = { ...st, splitToInvestors: st.splitToInvestors + toInvestors, splitToGp: st.splitToGp + toGp };
  return {
    state: st,
    tiers: { returnOfCapital: roc, preferredReturn: pref, gpCatchUp: catchUp, splitToInvestors: toInvestors, splitToGp: toGp },
  };
}

export function investorsShare(t: Tiers): Cents {
  return t.returnOfCapital + t.preferredReturn + t.splitToInvestors;
}

export function serialise(s: WaterfallState): string {
  return JSON.stringify({ ...s, prefAccrued: [s.prefAccrued.n.toString(), s.prefAccrued.d.toString()] });
}

export function deserialise(raw: string | null): WaterfallState {
  if (!raw) return emptyWaterfall();
  const o = JSON.parse(raw);
  return { ...o, prefAccrued: new Q(BigInt(o.prefAccrued[0]), BigInt(o.prefAccrued[1])) };
}
