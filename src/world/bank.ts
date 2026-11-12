/** The fund account's bank: books payments and writes camt.053.001.08 statements. */

export type Intent =
  | { kind: "investor"; investorKey: string; noticeKey: string; reference: string }
  | { kind: "noise" }
  | { kind: "fee" };

export interface Booking {
  entryRef: string;
  date: string;
  amount: number;
  credit: boolean;
  debtorName: string | null;
  debtorIban: string | null;
  structuredRef: string | null;
  unstructured: string | null;
  intent: Intent;
}

function money(c: number): string {
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function camt053(statementId: string, account: string, created: string, bookings: readonly Booking[]): string {
  const entries = bookings
    .map((b) => {
      const parties = [
        b.debtorName ? `<Dbtr><Pty><Nm>${esc(b.debtorName)}</Nm></Pty></Dbtr>` : "",
        b.debtorIban ? `<DbtrAcct><Id><IBAN>${b.debtorIban}</IBAN></Id></DbtrAcct>` : "",
      ].join("");
      const rmt = b.structuredRef
        ? `<RmtInf><Strd><CdtrRefInf><Tp><CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry></Tp><Ref>${b.structuredRef}</Ref></CdtrRefInf></Strd></RmtInf>`
        : b.unstructured
          ? `<RmtInf><Ustrd>${esc(b.unstructured)}</Ustrd></RmtInf>`
          : "";
      return `<Ntry><Amt Ccy="EUR">${money(b.amount)}</Amt><CdtDbtInd>${b.credit ? "CRDT" : "DBIT"}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>
<BookgDt><Dt>${b.date}</Dt></BookgDt><ValDt><Dt>${b.date}</Dt></ValDt><AcctSvcrRef>${b.entryRef}</AcctSvcrRef>
<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>${b.credit ? "RCDT" : "ICDT"}</Cd><SubFmlyCd>${b.credit ? "ESCT" : "CHRG"}</SubFmlyCd></Fmly></Domn></BkTxCd>
<NtryDtls><TxDtls>${parties ? `<RltdPties>${parties}</RltdPties>` : ""}${rmt}</TxDtls></NtryDtls></Ntry>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
<BkToCstmrStmt><GrpHdr><MsgId>${statementId}</MsgId><CreDtTm>${created}T06:00:00Z</CreDtTm></GrpHdr>
<Stmt><Id>${statementId}</Id><CreDtTm>${created}T06:00:00Z</CreDtTm><Acct><Id><IBAN>${account}</IBAN></Id><Ccy>EUR</Ccy></Acct>
${entries}
</Stmt></BkToCstmrStmt></Document>`;
}
