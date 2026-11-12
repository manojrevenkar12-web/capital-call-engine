import { Inject, Injectable } from "@nestjs/common";
import { rfReference } from "../../domain/identifiers";
import { Cents, eur } from "../../money/money";
import { FundRow, uuid } from "../common/common";
import { Tx } from "../db/db";
import { Metrics } from "../metrics/metrics";
import { METRICS } from "../tokens";

export interface InvestorRow {
  id: string;
  fund_id: string;
  number: number;
  name: string;
  email: string;
  iban: string;
  defaulted: number;
}

export interface NoticeRequest {
  kind: "call" | "catch_up" | "distribution";
  sourceId: string;
  sourceNumber: number;
  gross: Cents;
  interest: Cents;
  dueDate: string | null;
  issuedOn: string;
  title: string;
  lines: string[];
}

export interface NoticeRow {
  id: string;
  investor_id: string;
  kind: string;
  reference: string | null;
  gross: number;
  interest: number;
  credit_applied: number;
  amount_due: number;
  paid: number;
  due_date: string | null;
  status: string;
}

const LETTER = { call: "C", catch_up: "K", distribution: "D" } as const;

/**
 * Notices are the only way an investor learns what they owe. Each one is written with its
 * outbox message in the caller's transaction: the notice exists if and only if the message
 * to send it exists.
 */
@Injectable()
export class NoticesService {
  constructor(@Inject(METRICS) private readonly metrics: Metrics) {}

  async creditBalance(tx: Tx, fundId: string, investorId: string): Promise<Cents> {
    const r = await tx.one<{ s: number }>("SELECT COALESCE(SUM(amount), 0) AS s FROM credits WHERE fund_id = ? AND investor_id = ?", [fundId, investorId]);
    return Number(r?.s ?? 0);
  }

  async issue(tx: Tx, fund: FundRow, inv: InvestorRow, req: NoticeRequest): Promise<NoticeRow> {
    const id = uuid();
    const payable = req.kind !== "distribution";
    let creditApplied = 0;
    if (payable) {
      const balance = await this.creditBalance(tx, fund.id, inv.id);
      creditApplied = Math.max(0, Math.min(balance, req.gross + req.interest));
      if (creditApplied > 0) {
        await tx.run("INSERT INTO credits (tenant_id, fund_id, investor_id, kind, amount, source_id) VALUES (?, ?, ?, 'applied', ?, ?)", [
          fund.tenant_id, fund.id, inv.id, -creditApplied, id,
        ]);
      }
    }
    const due = payable ? req.gross + req.interest - creditApplied : 0;
    const reference = payable ? rfReference(`${fund.code}${LETTER[req.kind]}${req.sourceNumber}N${inv.number}`) : null;
    const status = !payable ? "info" : due === 0 ? "paid" : "open";
    await tx.run(
      `INSERT INTO notices (id, tenant_id, fund_id, investor_id, kind, source_id, reference, gross, interest, credit_applied, amount_due, due_date, status, issued_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, fund.tenant_id, fund.id, inv.id, req.kind, req.sourceId, reference, req.gross, req.interest, creditApplied, due, req.dueDate, status, req.issuedOn],
    );
    const body = [
      `${req.title} — ${fund.name}`,
      `Investor: ${inv.name} (no. ${inv.number})`,
      ...req.lines,
      ...(payable
        ? [
            `Your share: ${eurCode(req.gross)}`,
            ...(req.interest ? [`Equalisation interest: ${eurCode(req.interest)}`] : []),
            ...(creditApplied ? [`Less credit held for you: ${eurCode(creditApplied)}`] : []),
            `Amount due: ${eurCode(due)}`,
            ...(due > 0 ? [`Due date: ${req.dueDate}`, `Pay to: ${fund.name}, IBAN ${fund.account_iban}`, `Reference: ${reference}`] : ["Nothing to pay: covered by your credit."]),
          ]
        : [`Amount: ${eurCode(req.gross)}`, `Paid to your account ${inv.iban}`]),
    ].join("\n");
    await tx.run(
      `INSERT INTO outbox (tenant_id, notice_id, channel, recipient, subject, body, idempotency_key)
       VALUES (?, ?, 'email', ?, ?, ?, ?)`,
      [fund.tenant_id, id, inv.email, `${req.title} — ${fund.name}`, body, `notice-${id}`],
    );
    this.metrics.notices.inc({ kind: req.kind });
    return {
      id, investor_id: inv.id, kind: req.kind, reference, gross: req.gross, interest: req.interest,
      credit_applied: creditApplied, amount_due: due, paid: 0, due_date: req.dueDate, status,
    };
  }

  /** Declares defaults past the grace period and sends each defaulting investor one default notice. */
  async sweep(tx: Tx, fund: FundRow, asOf: string): Promise<{ defaulted: number }> {
    const late = await tx.all<NoticeRow & { email: string; name: string; number: number }>(
      `SELECT n.*, i.email, i.name, i.number FROM notices n JOIN investors i ON i.id = n.investor_id
        WHERE n.fund_id = ? AND n.tenant_id = ? AND n.status = 'open'
          AND DATE_ADD(n.due_date, INTERVAL ? DAY) < ? AND n.paid < n.amount_due`,
      [fund.id, fund.tenant_id, fund.grace_days, asOf],
    );
    for (const n of late) {
      await tx.run("UPDATE notices SET status = 'defaulted' WHERE id = ?", [n.id]);
      await tx.run("UPDATE investors SET defaulted = TRUE WHERE id = ?", [n.investor_id]);
      const rid = uuid();
      await tx.run(
        `INSERT INTO notices (id, tenant_id, fund_id, investor_id, kind, source_id, gross, amount_due, status, issued_on)
         VALUES (?, ?, ?, ?, 'reminder', ?, 0, 0, 'info', ?)`,
        [rid, fund.tenant_id, fund.id, n.investor_id, n.id, asOf],
      );
      const outstanding = n.amount_due - n.paid;
      const body = [
        `Notice of default — ${fund.name}`,
        `Investor: ${n.name} (no. ${n.number})`,
        `${eurCode(outstanding)} remains unpaid ${fund.grace_days} days after the due date ${n.due_date}.`,
        `Pay to: ${fund.name}, IBAN ${fund.account_iban}`,
        `Reference: ${n.reference}`,
      ].join("\n");
      await tx.run(
        `INSERT INTO outbox (tenant_id, notice_id, channel, recipient, subject, body, idempotency_key) VALUES (?, ?, 'email', ?, ?, ?, ?)`,
        [fund.tenant_id, rid, n.email, `Notice of default — ${fund.name}`, body, `notice-${rid}`],
      );
      this.metrics.notices.inc({ kind: "reminder" });
    }
    return { defaulted: late.length };
  }
}

export function eurCode(c: Cents): string {
  return eur(c).replace("€", "EUR ");
}

export async function fundInvestors(tx: Tx, fundId: string): Promise<InvestorRow[]> {
  return tx.all<InvestorRow>("SELECT * FROM investors WHERE fund_id = ? ORDER BY number", [fundId]);
}

/** Current commitment per investor: the sum of what they committed at each closing. */
export async function commitments(tx: Tx, fundId: string): Promise<Map<string, Cents>> {
  const rows = await tx.all<{ investor_id: string; s: number }>(
    "SELECT investor_id, SUM(amount) AS s FROM commitments WHERE fund_id = ? GROUP BY investor_id",
    [fundId],
  );
  return new Map(rows.map((r) => [r.investor_id, Number(r.s)]));
}

/**
 * Rounding ties go to the investor admitted first, so the domain functions work on keys
 * that sort by investor number rather than on database ids.
 */
export function numberKey(n: number): string {
  return `n${String(n).padStart(6, "0")}`;
}

export function keyMaps(investors: readonly InvestorRow[]) {
  const toKey = new Map(investors.map((i) => [i.id, numberKey(i.number)]));
  const toId = new Map(investors.map((i) => [numberKey(i.number), i.id]));
  return {
    rekey<V>(m: ReadonlyMap<string, V>): Map<string, V> {
      return new Map([...m].map(([id, v]) => [toKey.get(id)!, v]));
    },
    unkey<V>(m: ReadonlyMap<string, V>): Map<string, V> {
      return new Map([...m].map(([k, v]) => [toId.get(k)!, v]));
    },
  };
}
