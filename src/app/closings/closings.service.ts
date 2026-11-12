import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { z } from "zod";
import { addBusinessDays } from "../../domain/dates";
import { checkEqualisation, equalise, PriorCall } from "../../domain/equalisation";
import { Cents } from "../../money/money";
import { advanceEventDate, idempotent, isoDate, lockFund, parse, uuid } from "../common/common";
import { Db } from "../db/db";
import { commitments, fundInvestors, InvestorRow, keyMaps, NoticesService } from "../notices/notices.service";
import { DB } from "../tokens";

export const closingSchema = z.object({
  date: isoDate,
  entries: z
    .array(
      z.union([
        z.object({ documentId: z.string().uuid() }),
        z.object({ investorId: z.string().uuid(), increase: z.number().int().positive().safe() }),
      ]),
    )
    .min(1)
    .max(2000),
});

export interface ClosingResult {
  closingId: string;
  number: number;
  date: string;
  admitted: { investorId: string; number: number; name: string; commitment: Cents }[];
  increases: { investorId: string; increase: Cents }[];
  equalisation: {
    calls: number;
    catchUp: Cents;
    interest: Cents;
    interestToFund: Cents;
    payers: { investorId: string; catchUp: Cents; interest: Cents; noticeId: string }[];
    receivers: { investorId: string; rebalancing: Cents; interest: Cents }[];
  };
}

@Injectable()
export class ClosingsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(NoticesService) private readonly notices: NoticesService,
  ) {}

  async close(tenant: string, fundId: string, raw: unknown, key?: string): Promise<{ replayed: boolean; body: ClosingResult }> {
    const req = parse(closingSchema, raw);
    return this.db.tx((tx) =>
      idempotent(tx, tenant, key, { fundId, req }, async () => {
        const fund = await lockFund(tx, tenant, fundId);
        await advanceEventDate(tx, fund, req.date);
        const last = await tx.one<{ n: number }>("SELECT COALESCE(MAX(number), 0) AS n FROM closings WHERE fund_id = ?", [fund.id]);
        const number = Number(last!.n) + 1;
        const closingId = uuid();
        await tx.run("INSERT INTO closings (id, tenant_id, fund_id, number, close_date) VALUES (?, ?, ?, ?, ?)", [closingId, tenant, fund.id, number, req.date]);

        const before = await commitments(tx, fund.id);
        const maxNo = await tx.one<{ n: number }>("SELECT COALESCE(MAX(number), 0) AS n FROM investors WHERE fund_id = ?", [fund.id]);
        let nextNo = Number(maxNo!.n);
        const admitted: ClosingResult["admitted"] = [];
        const increases: ClosingResult["increases"] = [];
        const seen = new Set<string>();

        for (const e of req.entries) {
          if ("documentId" in e) {
            const doc = await tx.one("SELECT * FROM documents WHERE id = ? AND tenant_id = ? AND fund_id = ? FOR UPDATE", [e.documentId, tenant, fund.id]);
            if (!doc) throw new NotFoundException(`document ${e.documentId} not found`);
            if (doc.status !== "accepted" && doc.status !== "resolved") {
              throw new UnprocessableEntityException(`document ${e.documentId} is ${doc.status}; only accepted or resolved documents can be closed`);
            }
            const f = JSON.parse(doc.fields);
            const investorId = uuid();
            nextNo += 1;
            await tx.run("INSERT INTO investors (id, tenant_id, fund_id, number, name, email, iban) VALUES (?, ?, ?, ?, ?, ?, ?)", [
              investorId, tenant, fund.id, nextNo, f.investorName, f.email, f.iban,
            ]);
            await tx.run("INSERT INTO commitments (tenant_id, fund_id, investor_id, closing_id, amount, document_id) VALUES (?, ?, ?, ?, ?, ?)", [
              tenant, fund.id, investorId, closingId, f.commitment, doc.id,
            ]);
            await tx.run("UPDATE documents SET status = 'used' WHERE id = ?", [doc.id]);
            admitted.push({ investorId, number: nextNo, name: f.investorName, commitment: f.commitment });
          } else {
            if (!before.has(e.investorId)) throw new NotFoundException(`investor ${e.investorId} has no commitment in this fund`);
            if (seen.has(e.investorId)) throw new UnprocessableEntityException(`investor ${e.investorId} appears twice`);
            seen.add(e.investorId);
            await tx.run("INSERT INTO commitments (tenant_id, fund_id, investor_id, closing_id, amount) VALUES (?, ?, ?, ?, ?)", [
              tenant, fund.id, e.investorId, closingId, e.increase,
            ]);
            increases.push({ investorId: e.investorId, increase: e.increase });
          }
        }

        const after = await commitments(tx, fund.id);
        const calls = await tx.all<{ id: string; number: number; call_date: string; amount: number }>(
          "SELECT id, number, call_date, amount FROM calls WHERE fund_id = ? ORDER BY number",
          [fund.id],
        );
        const result: ClosingResult = {
          closingId, number, date: req.date, admitted, increases,
          equalisation: { calls: calls.length, catchUp: 0, interest: 0, interestToFund: 0, payers: [], receivers: [] },
        };
        if (calls.length === 0) return result;
        if (number === 1) throw new ConflictException("calls exist before the first closing");

        const shares = await tx.all<{ call_id: string; investor_id: string; amount: number }>(
          "SELECT call_id, investor_id, amount FROM call_shares WHERE fund_id = ?",
          [fund.id],
        );
        const byCall = new Map<string, Map<string, Cents>>();
        for (const s of shares) {
          if (!byCall.has(s.call_id)) byCall.set(s.call_id, new Map());
          byCall.get(s.call_id)!.set(s.investor_id, Number(s.amount));
        }
        const allInvestors = await fundInvestors(tx, fund.id);
        const keys = keyMaps(allInvestors);
        const prior: PriorCall[] = calls.map((c) => ({ id: c.id, date: c.call_date, amount: Number(c.amount), funded: keys.rekey(byCall.get(c.id) ?? new Map()) }));
        const keyed = equalise(keys.rekey(after), prior, req.date, { rateBps: fund.eq_rate_bps, interestTo: fund.eq_interest_to });
        const problems = checkEqualisation(keyed);
        if (problems.length) throw new Error(`equalisation does not balance: ${problems.join("; ")}`);
        const eq = {
          ...keyed,
          calls: keyed.calls.map((c) => ({ ...c, target: keys.unkey(c.target), delta: keys.unkey(c.delta), interestPaid: keys.unkey(c.interestPaid), interestReceived: keys.unkey(c.interestReceived) })),
          catchUp: keys.unkey(keyed.catchUp),
          rebalanceCredit: keys.unkey(keyed.rebalanceCredit),
          interestDue: keys.unkey(keyed.interestDue),
          interestCredit: keys.unkey(keyed.interestCredit),
        };

        for (const c of eq.calls) {
          for (const [inv, d] of c.delta) {
            if (d === 0) continue;
            await tx.run(
              `INSERT INTO call_shares (call_id, investor_id, tenant_id, fund_id, amount) VALUES (?, ?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE amount = VALUES(amount)`,
              [c.callId, inv, tenant, fund.id, c.target.get(inv)!],
            );
            await tx.run(
              "INSERT INTO share_changes (tenant_id, fund_id, closing_id, call_id, investor_id, delta, interest_paid, interest_received) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              [tenant, fund.id, closingId, c.callId, inv, d, c.interestPaid.get(inv) ?? 0, c.interestReceived.get(inv) ?? 0],
            );
          }
        }
        if (eq.interestToFund) await tx.run("UPDATE closings SET interest_to_fund = ? WHERE id = ?", [eq.interestToFund, closingId]);

        const investors = new Map(allInvestors.map((i) => [i.id, i] as [string, InvestorRow]));
        for (const [inv, amount] of eq.rebalanceCredit) {
          await tx.run("INSERT INTO credits (tenant_id, fund_id, investor_id, kind, amount, source_id) VALUES (?, ?, ?, 'rebalancing', ?, ?)", [tenant, fund.id, inv, amount, closingId]);
          const interest = eq.interestCredit.get(inv) ?? 0;
          if (interest) {
            await tx.run("INSERT INTO credits (tenant_id, fund_id, investor_id, kind, amount, source_id) VALUES (?, ?, ?, 'interest', ?, ?)", [tenant, fund.id, inv, interest, closingId]);
          }
          result.equalisation.receivers.push({ investorId: inv, rebalancing: amount, interest });
        }
        const dueDate = addBusinessDays(req.date, fund.notice_days);
        for (const [inv, catchUp] of eq.catchUp) {
          const interest = eq.interestDue.get(inv) ?? 0;
          const n = await this.notices.issue(tx, fund, investors.get(inv)!, {
            kind: "catch_up",
            sourceId: closingId,
            sourceNumber: number,
            gross: catchUp,
            interest,
            dueDate,
            issuedOn: req.date,
            title: `Closing ${number} equalisation notice`,
            lines: [`Closing ${number} on ${req.date}: your share of the ${calls.length} earlier call(s), as if you had joined at the first closing.`],
          });
          result.equalisation.payers.push({ investorId: inv, catchUp, interest, noticeId: n.id });
          result.equalisation.catchUp += catchUp;
          result.equalisation.interest += interest;
        }
        result.equalisation.interestToFund = eq.interestToFund;
        return result;
      }),
    );
  }
}
