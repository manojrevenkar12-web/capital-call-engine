import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { z } from "zod";
import { parseCamt053, StatementEntry, StatementError } from "../../domain/camt053";
import { matchEntry, PayableNotice } from "../../domain/matching";
import { Cents } from "../../money/money";
import { EngineConfig } from "../config";
import { FundRow, lockFund, parse, readFund } from "../common/common";
import { Db, isDuplicate, Tx } from "../db/db";
import { Metrics } from "../metrics/metrics";
import { CONFIG, DB, METRICS } from "../tokens";

export interface IngestResult {
  entries: number;
  duplicates: number;
  applied: number;
  review: number;
  ignored: number;
  byKind: Record<string, number>;
}

export const assignSchema = z.union([
  z.object({ action: z.literal("apply"), noticeId: z.string().uuid() }),
  z.object({ action: z.literal("refund"), note: z.string().min(3).max(200) }),
]);

/**
 * Reads the fund account's camt.053 statements, ties each credit to a notice and applies it.
 * A statement sent twice changes nothing: each entry is keyed by the bank's own reference.
 */
@Injectable()
export class StatementsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: EngineConfig,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  async ingest(tenant: string, xml: string): Promise<IngestResult> {
    let entries: StatementEntry[];
    try {
      entries = parseCamt053(xml);
    } catch (e) {
      if (e instanceof StatementError) throw new BadRequestException(e.message);
      throw e;
    }
    const byAccount = new Map<string, StatementEntry[]>();
    for (const e of entries) byAccount.set(e.account, [...(byAccount.get(e.account) ?? []), e]);
    const funds = new Map<string, string>();
    for (const account of byAccount.keys()) {
      const f = await this.db.one("SELECT id FROM funds WHERE account_iban = ? AND tenant_id = ?", [account, tenant]);
      if (!f) throw new UnprocessableEntityException(`account ${account} is not a fund account of this manager`);
      funds.set(account, f.id);
    }
    const out: IngestResult = { entries: entries.length, duplicates: 0, applied: 0, review: 0, ignored: 0, byKind: {} };
    for (const [account, list] of byAccount) {
      await this.db.tx(async (tx) => {
        const fund = await lockFund(tx, tenant, funds.get(account)!);
        const notices = await payableNotices(tx, fund.id);
        const owners = await ibanOwners(tx, fund.id);
        for (const e of list) {
          const m = matchEntry(e, fund.currency, notices, owners, { ibanFallback: this.config.matching.iban_fallback });
          let applied = 0;
          let unapplied = 0;
          let status: "applied" | "review" | "ignored" = "ignored";
          let reason: string | null = null;
          let noticeId: string | null = null;
          if (m.kind === "ignored") reason = m.reason;
          else if (m.kind === "review") {
            status = "review";
            reason = m.reason;
            unapplied = e.amount;
          } else {
            noticeId = m.noticeId;
            const n = notices.find((x) => x.noticeId === m.noticeId)!;
            applied = Math.min(e.amount, n.outstanding);
            unapplied = e.amount - applied;
            status = unapplied > 0 ? "review" : "applied";
            if (unapplied > 0) reason = applied > 0 ? "paid more than was due" : "notice was already paid";
          }
          try {
            await tx.run(
              `INSERT INTO bank_entries (tenant_id, fund_id, entry_ref, statement_id, amount, currency, booking_date, debtor_iban, debtor_name,
                 structured_ref, unstructured, match_kind, notice_id, applied, unapplied, review_reason, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [tenant, fund.id, e.entryRef, e.statementId, e.amount, e.currency, e.bookingDate, e.debtorIban, e.debtorName,
                e.structuredRef, e.unstructured?.slice(0, 500) ?? null, m.kind, noticeId, applied, unapplied, reason, status],
            );
          } catch (err) {
            if (!isDuplicate(err)) throw err;
            out.duplicates += 1;
            continue;
          }
          if (applied > 0) await applyToNotice(tx, fund, noticeId!, applied, notices);
          out.byKind[m.kind] = (out.byKind[m.kind] ?? 0) + 1;
          this.metrics.matches.inc({ kind: m.kind });
          if (status === "review") {
            out.review += 1;
            this.metrics.reviews.inc({ source: "payment" });
          } else if (status === "applied") out.applied += 1;
          else out.ignored += 1;
        }
      });
    }
    return out;
  }

  /** A person settles an entry code would not: apply it to a notice, or record that it is being refunded. */
  async resolve(tenant: string, entryId: number, raw: unknown, reviewer: string): Promise<{ status: string; applied: Cents }> {
    const req = parse(assignSchema, raw);
    const entry = await this.db.one("SELECT * FROM bank_entries WHERE id = ? AND tenant_id = ?", [entryId, tenant]);
    if (!entry) throw new NotFoundException("bank entry not found");
    return this.db.tx(async (tx) => {
      const fund = await lockFund(tx, tenant, entry.fund_id);
      const e = await tx.one("SELECT * FROM bank_entries WHERE id = ? FOR UPDATE", [entryId]);
      if (e!.status !== "review" || e!.unapplied <= 0) throw new ConflictException(`entry is ${e!.status}`);
      if (req.action === "refund") {
        await tx.run("UPDATE bank_entries SET status = 'resolved', review_reason = ? WHERE id = ?", [`refund by ${reviewer}: ${req.note}`, entryId]);
        return { status: "resolved", applied: 0 };
      }
      const notices = await payableNotices(tx, fund.id);
      const n = notices.find((x) => x.noticeId === req.noticeId);
      if (!n) throw new NotFoundException("notice not found in this fund");
      const applied = Math.min(e!.unapplied, n.outstanding);
      if (applied === 0) throw new ConflictException("that notice has nothing outstanding");
      await applyToNotice(tx, fund, n.noticeId, applied, notices);
      const left = e!.unapplied - applied;
      await tx.run(
        "UPDATE bank_entries SET applied = applied + ?, unapplied = ?, notice_id = COALESCE(notice_id, ?), status = ?, review_reason = ? WHERE id = ?",
        [applied, left, n.noticeId, left > 0 ? "review" : "resolved", left > 0 ? "paid more than was due" : `applied by ${reviewer}`, entryId],
      );
      return { status: left > 0 ? "review" : "resolved", applied };
    });
  }

  async review(tenant: string, fundId: string) {
    await this.db.tx((tx) => readFund(tx, tenant, fundId));
    return this.db.all(
      `SELECT id, entry_ref, amount, unapplied, booking_date, debtor_name, debtor_iban, structured_ref, unstructured, review_reason, notice_id
         FROM bank_entries WHERE tenant_id = ? AND fund_id = ? AND status = 'review' ORDER BY booking_date, id`,
      [tenant, fundId],
    );
  }
}

async function payableNotices(tx: Tx, fundId: string): Promise<(PayableNotice & { status: string })[]> {
  const rows = await tx.all<{ id: string; investor_id: string; reference: string; amount_due: number; paid: number; status: string }>(
    "SELECT id, investor_id, reference, amount_due, paid, status FROM notices WHERE fund_id = ? AND kind IN ('call','catch_up') ORDER BY issued_on, id",
    [fundId],
  );
  return rows.map((r) => ({ noticeId: r.id, investorId: r.investor_id, reference: r.reference, outstanding: Math.max(0, r.amount_due - r.paid), status: r.status }));
}

async function ibanOwners(tx: Tx, fundId: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const r of await tx.all<{ id: string; iban: string }>("SELECT id, iban FROM investors WHERE fund_id = ?", [fundId])) {
    out.set(r.iban, [...(out.get(r.iban) ?? []), r.id]);
  }
  return out;
}

async function applyToNotice(tx: Tx, fund: FundRow, noticeId: string, amount: Cents, cache: (PayableNotice & { status: string })[]): Promise<void> {
  await tx.run(
    "UPDATE notices SET paid = paid + ?, status = IF(paid >= amount_due, 'paid', status) WHERE id = ? AND fund_id = ?",
    [amount, noticeId, fund.id],
  );
  const n = cache.find((x) => x.noticeId === noticeId);
  if (n) n.outstanding -= amount;
  const row = await tx.one<{ investor_id: string }>("SELECT investor_id FROM notices WHERE id = ?", [noticeId]);
  // A default is cured when nothing the investor owes is still in default.
  await tx.run(
    "UPDATE investors SET defaulted = EXISTS (SELECT 1 FROM notices WHERE investor_id = ? AND status = 'defaulted') WHERE id = ?",
    [row!.investor_id, row!.investor_id],
  );
}
