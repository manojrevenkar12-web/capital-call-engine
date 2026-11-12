import { Cents } from "../money/money";
import { StatementEntry } from "./camt053";
import { findRfReferences, isValidRf } from "./identifiers";

/** A notice an investor can pay against: a capital call, a closing catch-up or a reminder of either. */
export interface PayableNotice {
  noticeId: string;
  investorId: string;
  reference: string;
  outstanding: Cents;
}

export type Match =
  | { kind: "reference" | "reference_in_text" | "iban_amount" | "iban_single"; noticeId: string }
  | { kind: "review"; reason: string }
  | { kind: "ignored"; reason: string };

export interface MatchSettings {
  /** Fall back to the payer's known IBAN when the reference is missing or wrong. */
  ibanFallback: boolean;
}

/**
 * Ties one credit on the fund's account to one notice. A reference decides first; the
 * payer's account is only a fallback, and only when it points at a single notice or the
 * amount equals exactly one open notice. Anything less certain goes to a person.
 */
export function matchEntry(
  e: StatementEntry,
  currency: string,
  notices: readonly PayableNotice[],
  ibanOwners: ReadonlyMap<string, readonly string[]>,
  settings: MatchSettings,
): Match {
  if (!e.credit) return { kind: "ignored", reason: "debit" };
  if (e.currency !== currency) return { kind: "review", reason: `currency ${e.currency} on a ${currency} fund` };
  const byRef = new Map(notices.map((n) => [n.reference, n]));
  const payerOwners = e.debtorIban ? ibanOwners.get(e.debtorIban) ?? [] : [];
  // A reference wins unless the money came from an account we know belongs to someone else.
  const payerConflict = (n: PayableNotice) => payerOwners.length > 0 && !payerOwners.includes(n.investorId);

  if (e.structuredRef && isValidRf(e.structuredRef)) {
    const n = byRef.get(e.structuredRef.toUpperCase().replace(/\s/g, ""));
    if (n) {
      if (payerConflict(n)) return { kind: "review", reason: "reference belongs to another investor's notice" };
      return { kind: "reference", noticeId: n.noticeId };
    }
  }
  const inText = findRfReferences(e.unstructured ?? "")
    .map((r) => byRef.get(r))
    .filter((n): n is PayableNotice => Boolean(n));
  const distinct = [...new Set(inText.map((n) => n.noticeId))];
  if (distinct.length > 1) return { kind: "review", reason: "several notice references in one payment" };
  if (distinct.length === 1) {
    const n = inText[0];
    if (payerConflict(n)) return { kind: "review", reason: "reference belongs to another investor's notice" };
    return { kind: "reference_in_text", noticeId: n.noticeId };
  }

  if (!settings.ibanFallback) return { kind: "review", reason: "no usable reference" };
  if (!e.debtorIban) return { kind: "review", reason: "no reference and no payer account" };
  const owners = payerOwners;
  if (owners.length !== 1) {
    return { kind: "review", reason: owners.length ? "payer account shared by several investors" : "unknown payer account" };
  }
  const open = notices.filter((n) => n.investorId === owners[0] && n.outstanding > 0);
  const exact = open.filter((n) => n.outstanding === e.amount);
  if (exact.length === 1) return { kind: "iban_amount", noticeId: exact[0].noticeId };
  if (open.length === 1) return { kind: "iban_single", noticeId: open[0].noticeId };
  return { kind: "review", reason: open.length ? "several open notices and the amount fits none" : "nothing open for this investor" };
}
