import { addBusinessDays, days } from "../domain/dates";
import { WorldFund } from "./world";

/**
 * The answer key, worked out directly from the fund's history. It is written separately
 * from the engine's code: its own rounding, its own event loop, and a day-by-day waterfall
 * where the engine works interval by interval. The rules both follow are the ones the LPA
 * sets: largest-remainder rounding with ties to the lower investor number, equalisation
 * interest rounded half up per investor per call, credits from a closing netted against
 * that closing's catch-up and then against later notices.
 */

export interface TruthNotice {
  key: string;
  investorKey: string;
  kind: "call" | "catch_up" | "distribution";
  sourceNumber: number;
  gross: number;
  interest: number;
  creditApplied: number;
  due: number;
  dueDate: string | null;
  date: string;
}

export interface TruthTiers {
  returnOfCapital: number;
  preferredReturn: number;
  gpCatchUp: number;
  splitToInvestors: number;
  splitToGp: number;
}

export interface FundTruth {
  commitments: Map<string, number>;
  /** call number -> investor key -> final share */
  shares: Map<number, Map<string, number>>;
  /** closing number -> investor key -> amounts */
  equalisation: Map<number, Map<string, { catchUp: number; rebalance: number; interestPaid: number; interestReceived: number }>>;
  notices: TruthNotice[];
  tiers: Map<number, TruthTiers>;
}

function split(total: number, weights: [string, number][]): Map<string, number> {
  const T = BigInt(total);
  const W = weights.reduce((a, [, w]) => a + BigInt(w), 0n);
  const rows = weights.map(([k, w]) => {
    const exact = T * BigInt(w);
    return { k, base: exact / W, rem: exact % W };
  });
  let left = T - rows.reduce((a, r) => a + r.base, 0n);
  const order = [...rows].sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.k.localeCompare(b.k)));
  const extra = new Set<string>();
  for (const r of order) {
    if (left <= 0n) break;
    extra.add(r.k);
    left -= 1n;
  }
  return new Map(rows.map((r) => [r.k, Number(r.base) + (extra.has(r.k) ? 1 : 0)]));
}

function halfUp(num: bigint, den: bigint): number {
  return Number((2n * num + den) / (2n * den));
}

export function fundTruth(f: WorldFund): FundTruth {
  const keyOrder = (k: string) => k; // investor keys sort by number, as the engine's ids sort by its own order
  void keyOrder;
  const commitments = new Map<string, number>();
  const shares = new Map<number, Map<string, number>>();
  const credit = new Map<string, number>();
  const notices: TruthNotice[] = [];
  const equalisation: FundTruth["equalisation"] = new Map();
  const tiers = new Map<number, TruthTiers>();

  type Ev = { date: string; order: number; run: () => void };
  const events: Ev[] = [];

  const issue = (n: Omit<TruthNotice, "creditApplied" | "due">) => {
    let applied = 0;
    if (n.kind !== "distribution") {
      const bal = credit.get(n.investorKey) ?? 0;
      applied = Math.min(bal, n.gross + n.interest);
      credit.set(n.investorKey, bal - applied);
    }
    notices.push({ ...n, creditApplied: applied, due: n.kind === "distribution" ? 0 : n.gross + n.interest - applied });
  };

  for (const c of f.closings) {
    events.push({
      date: c.date,
      order: 0,
      run: () => {
        for (const k of c.admitted) commitments.set(k, f.investors.find((i) => i.key === k)!.commitment);
        for (const inc of c.increases) commitments.set(inc.key, commitments.get(inc.key)! + inc.amount);
        const w = [...commitments.entries()];
        const per = new Map<string, { catchUp: number; rebalance: number; interestPaid: number; interestReceived: number }>();
        const get = (k: string) => {
          if (!per.has(k)) per.set(k, { catchUp: 0, rebalance: 0, interestPaid: 0, interestReceived: 0 });
          return per.get(k)!;
        };
        for (const [callNo, cur] of [...shares.entries()].sort((a, b) => a[0] - b[0])) {
          const call = f.calls.find((x) => x.number === callNo)!;
          const next = split(call.amount, w);
          const elapsed = BigInt(days(call.date, c.date));
          let pool = 0;
          const receivers: [string, number][] = [];
          for (const [k, v] of next) {
            const d = v - (cur.get(k) ?? 0);
            if (d > 0) {
              get(k).catchUp += d;
              const i = halfUp(BigInt(d) * BigInt(f.terms.eqRateBps) * elapsed, 10_000n * 365n);
              get(k).interestPaid += i;
              pool += i;
            } else if (d < 0) {
              get(k).rebalance += -d;
              receivers.push([k, -d]);
            }
          }
          if (pool > 0 && receivers.length) for (const [k, v] of split(pool, receivers)) get(k).interestReceived += v;
          shares.set(callNo, next);
        }
        equalisation.set(c.number, per);
        for (const [k, p] of [...per.entries()].sort()) {
          if (p.rebalance) credit.set(k, (credit.get(k) ?? 0) + p.rebalance + p.interestReceived);
        }
        for (const [k, p] of [...per.entries()].sort()) {
          if (p.catchUp > 0) {
            issue({
              key: `${f.key}|catch_up|${c.number}|${k}`, investorKey: k, kind: "catch_up", sourceNumber: c.number,
              gross: p.catchUp, interest: p.interestPaid, dueDate: addBusinessDays(c.date, f.terms.noticeDays), date: c.date,
            });
          }
        }
      },
    });
  }
  for (const call of f.calls) {
    events.push({
      date: call.date,
      order: 1,
      run: () => {
        const s = split(call.amount, [...commitments.entries()]);
        shares.set(call.number, s);
        for (const [k, v] of [...s.entries()].sort()) {
          if (v === 0) continue;
          issue({
            key: `${f.key}|call|${call.number}|${k}`, investorKey: k, kind: "call", sourceNumber: call.number,
            gross: v, interest: 0, dueDate: addBusinessDays(call.date, f.terms.noticeDays), date: call.date,
          });
        }
      },
    });
  }

  // Day-by-day waterfall: preferred return accrues as an exact fraction over (10,000 x 365).
  const DEN = 10_000n * 365n;
  let outstanding = 0n;
  let accruedNum = 0n;
  let prefPaid = 0n;
  let catchUpPaid = 0n;
  let lastDay: string | null = null;
  const advance = (to: string) => {
    if (lastDay !== null) {
      for (let i = days(lastDay, to); i > 0; i--) accruedNum += outstanding * BigInt(f.terms.prefBps);
    }
    lastDay = to;
  };
  for (const call of f.calls) {
    events.push({ date: call.date, order: 2, run: () => { advance(call.date); outstanding += BigInt(call.amount); } });
  }
  for (const dist of f.distributions) {
    events.push({
      date: dist.date,
      order: 3,
      run: () => {
        advance(dist.date);
        let rest = BigInt(dist.amount);
        const roc = rest < outstanding ? rest : outstanding;
        rest -= roc;
        outstanding -= roc;
        const due = accruedNum / DEN - prefPaid; // floor of the accrued fraction, less what was paid
        const pref = due <= 0n ? 0n : rest < due ? rest : due;
        rest -= pref;
        prefPaid += pref;
        const carry = BigInt(f.terms.carryBps);
        const target = (prefPaid * carry) / (10_000n - carry) - catchUpPaid;
        const cu = target <= 0n ? 0n : rest < target ? rest : target;
        rest -= cu;
        catchUpPaid += cu;
        const gp = split(Number(rest), [["gp", f.terms.carryBps], ["lp", 10_000 - f.terms.carryBps]]);
        const t: TruthTiers = {
          returnOfCapital: Number(roc), preferredReturn: Number(pref), gpCatchUp: Number(cu),
          splitToInvestors: gp.get("lp")!, splitToGp: gp.get("gp")!,
        };
        tiers.set(dist.number, t);
        const called = new Map<string, number>();
        for (const s of shares.values()) for (const [k, v] of s) called.set(k, (called.get(k) ?? 0) + v);
        const weights = [...called.entries()].filter(([, v]) => v > 0);
        const toInvestors = t.returnOfCapital + t.preferredReturn + t.splitToInvestors;
        for (const [k, v] of [...split(toInvestors, weights).entries()].sort()) {
          if (v === 0) continue;
          notices.push({
            key: `${f.key}|distribution|${dist.number}|${k}`, investorKey: k, kind: "distribution", sourceNumber: dist.number,
            gross: v, interest: 0, creditApplied: 0, due: 0, dueDate: null, date: dist.date,
          });
        }
      },
    });
  }

  events.sort((a, b) => (a.date === b.date ? a.order - b.order : a.date < b.date ? -1 : 1));
  for (const e of events) e.run();
  return { commitments, shares, equalisation, notices, tiers };
}
