import { allocate, Cents, Q } from "../money/money";
import { days, IsoDate } from "./dates";

/**
 * Subsequent-close equalisation, done call by call.
 *
 * When investors join (or existing investors increase) at a later closing, the fund is
 * re-split as if everyone had been admitted at the first closing. For every call made
 * so far, each investor's share is recomputed from the new commitments. Investors whose
 * share went up pay the difference (catch-up) plus equalisation interest from that call's
 * date to the closing date; investors whose share went down are credited the difference
 * and receive that call's interest, split by how much each of them was rebalanced.
 *
 * Working per call is what makes several closings come out right: an investor admitted
 * at the second closing is a payer for the calls before it and a receiver at the third.
 */

export interface PriorCall {
  id: string;
  date: IsoDate;
  amount: Cents;
  /** Each investor's current share of this call, after any earlier equalisation. */
  funded: ReadonlyMap<string, Cents>;
}

export interface EqualisationTerms {
  /** Annual simple interest in basis points, ACT/365, as the LPA sets it. */
  rateBps: number;
  /** Who receives equalisation interest: the rebalanced investors, or the fund itself. */
  interestTo: "rebalanced_investors" | "fund";
}

export interface CallEqualisation {
  callId: string;
  target: Map<string, Cents>;
  delta: Map<string, Cents>;
  interestPaid: Map<string, Cents>;
  interestReceived: Map<string, Cents>;
}

export interface Equalisation {
  closeDate: IsoDate;
  calls: CallEqualisation[];
  /** Per investor: catch-up owed (positive) and rebalancing credit (positive). */
  catchUp: Map<string, Cents>;
  rebalanceCredit: Map<string, Cents>;
  interestDue: Map<string, Cents>;
  interestCredit: Map<string, Cents>;
  /** Interest kept by the fund when the LPA says so. */
  interestToFund: Cents;
}

export function equalise(
  commitmentsAfter: ReadonlyMap<string, Cents>,
  calls: readonly PriorCall[],
  closeDate: IsoDate,
  terms: EqualisationTerms,
): Equalisation {
  const catchUp = new Map<string, Cents>();
  const rebalanceCredit = new Map<string, Cents>();
  const interestDue = new Map<string, Cents>();
  const interestCredit = new Map<string, Cents>();
  let interestToFund = 0;
  const out: CallEqualisation[] = [];
  const add = (m: Map<string, Cents>, k: string, v: Cents) => m.set(k, (m.get(k) ?? 0) + v);

  for (const call of calls) {
    if (call.date > closeDate) throw new Error(`call ${call.id} is after the closing`);
    let fundedTotal = 0;
    for (const v of call.funded.values()) fundedTotal += v;
    if (fundedTotal !== call.amount) {
      throw new Error(`call ${call.id}: shares sum to ${fundedTotal}, call is ${call.amount}`);
    }
    const target = allocate(call.amount, commitmentsAfter);
    const delta = new Map<string, Cents>();
    for (const [lp, t] of target) delta.set(lp, t - (call.funded.get(lp) ?? 0));
    for (const [lp, p] of call.funded) {
      if (!target.has(lp)) throw new Error(`call ${call.id}: ${lp} funded it but has no commitment`);
      void p;
    }
    const elapsed = days(call.date, closeDate);
    const interestPaid = new Map<string, Cents>();
    let pool = 0;
    const receivers = new Map<string, bigint>();
    for (const [lp, d] of delta) {
      if (d > 0) {
        add(catchUp, lp, d);
        const i = Q.of(d)
          .mul(new Q(BigInt(terms.rateBps), 10_000n))
          .mul(new Q(BigInt(elapsed), 365n))
          .round();
        if (i > 0) {
          interestPaid.set(lp, i);
          add(interestDue, lp, i);
          pool += i;
        }
      } else if (d < 0) {
        add(rebalanceCredit, lp, -d);
        receivers.set(lp, BigInt(-d));
      }
    }
    let interestReceived = new Map<string, Cents>();
    if (pool > 0) {
      if (terms.interestTo === "fund" || receivers.size === 0) interestToFund += pool;
      else {
        interestReceived = allocate(pool, receivers);
        for (const [lp, v] of interestReceived) if (v) add(interestCredit, lp, v);
      }
    }
    out.push({ callId: call.id, target, delta, interestPaid, interestReceived });
  }
  return { closeDate, calls: out, catchUp, rebalanceCredit, interestDue, interestCredit, interestToFund };
}

/** Conservation checks the service runs before it commits a closing. */
export function checkEqualisation(e: Equalisation): string[] {
  const problems: string[] = [];
  for (const c of e.calls) {
    let s = 0;
    for (const v of c.delta.values()) s += v;
    if (s !== 0) problems.push(`call ${c.callId}: deltas sum to ${s}`);
    let paid = 0;
    let got = 0;
    for (const v of c.interestPaid.values()) paid += v;
    for (const v of c.interestReceived.values()) got += v;
    if (got !== 0 && paid !== got) problems.push(`call ${c.callId}: interest paid ${paid} != received ${got}`);
  }
  let cu = 0;
  let rb = 0;
  for (const v of e.catchUp.values()) cu += v;
  for (const v of e.rebalanceCredit.values()) rb += v;
  if (cu !== rb) problems.push(`catch-up ${cu} != rebalancing ${rb}`);
  return problems;
}
