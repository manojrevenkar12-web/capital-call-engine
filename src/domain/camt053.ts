import { XMLParser } from "fast-xml-parser";
import { Cents } from "../money/money";
import { IsoDate } from "./dates";
import { normaliseIban } from "./identifiers";

/** One booked line of an ISO 20022 camt.053 bank-to-customer statement. */
export interface StatementEntry {
  statementId: string;
  account: string;
  /** The bank's own reference for the entry; a re-sent statement repeats it. */
  entryRef: string;
  amount: Cents;
  currency: string;
  credit: boolean;
  bookingDate: IsoDate;
  valueDate: IsoDate;
  debtorName: string | null;
  debtorIban: string | null;
  structuredRef: string | null;
  unstructured: string | null;
}

export class StatementError extends Error {}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false,
  isArray: (name) => ["Stmt", "Ntry", "TxDtls", "Ustrd"].includes(name),
});

export function amountToCents(raw: string): Cents {
  const s = String(raw).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new StatementError(`bad amount: ${raw}`);
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

function text(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>)) return String((v as Record<string, unknown>)["#text"]);
  return String(v);
}

export function parseCamt053(xml: string): StatementEntry[] {
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch (e) {
    throw new StatementError(`not XML: ${(e as Error).message}`);
  }
  const root = doc?.Document?.BkToCstmrStmt;
  if (!root?.Stmt) throw new StatementError("no BkToCstmrStmt/Stmt");
  const out: StatementEntry[] = [];
  for (const st of root.Stmt) {
    const statementId = text(st.Id);
    const account = text(st.Acct?.Id?.IBAN);
    if (!statementId || !account) throw new StatementError("statement without Id or account IBAN");
    for (const n of st.Ntry ?? []) {
      const status = text(n.Sts?.Cd) ?? text(n.Sts);
      if (status && status !== "BOOK") continue;
      const tx = n.NtryDtls?.TxDtls?.[0] ?? {};
      const amt = n.Amt;
      const entryRef = text(n.AcctSvcrRef);
      if (!entryRef) throw new StatementError(`entry without AcctSvcrRef in ${statementId}`);
      const dbtr = tx.RltdPties?.Dbtr;
      const ustrd: string[] = (tx.RmtInf?.Ustrd ?? []).map((u: unknown) => text(u) ?? "");
      const debtorIban = text(tx.RltdPties?.DbtrAcct?.Id?.IBAN);
      out.push({
        statementId,
        account: normaliseIban(account),
        entryRef,
        amount: amountToCents(text(amt) ?? ""),
        currency: amt?.["@Ccy"] ?? "",
        credit: text(n.CdtDbtInd) === "CRDT",
        bookingDate: text(n.BookgDt?.Dt) ?? "",
        valueDate: text(n.ValDt?.Dt) ?? text(n.BookgDt?.Dt) ?? "",
        debtorName: text(dbtr?.Pty?.Nm) ?? text(dbtr?.Nm),
        debtorIban: debtorIban ? normaliseIban(debtorIban) : null,
        structuredRef: text(tx.RmtInf?.Strd?.CdtrRefInf?.Ref),
        unstructured: ustrd.length ? ustrd.join(" ") : null,
      });
    }
  }
  return out;
}
