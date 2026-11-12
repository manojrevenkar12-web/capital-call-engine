import { Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { z } from "zod";
import { addBusinessDays } from "../../domain/dates";
import { allocate, Cents, eur } from "../../money/money";
import { advanceEventDate, idempotent, isoDate, lockFund, parse, uuid } from "../common/common";
import { Db } from "../db/db";
import { commitments, fundInvestors, keyMaps, NoticesService } from "../notices/notices.service";
import { DB } from "../tokens";

export const callSchema = z.object({
  date: isoDate,
  amount: z.number().int().positive().safe(),
  purpose: z.enum(["investment", "management_fee", "fund_expenses"]),
});

export interface CallResult {
  callId: string;
  number: number;
  date: string;
  dueDate: string;
  amount: Cents;
  notices: { investorId: string; share: Cents; creditApplied: Cents; amountDue: Cents; reference: string | null }[];
}

@Injectable()
export class CallsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(NoticesService) private readonly notices: NoticesService,
  ) {}

  async call(tenant: string, fundId: string, raw: unknown, key?: string): Promise<{ replayed: boolean; body: CallResult }> {
    const req = parse(callSchema, raw);
    return this.db.tx((tx) =>
      idempotent(tx, tenant, key, { fundId, req }, async () => {
        const fund = await lockFund(tx, tenant, fundId);
        await advanceEventDate(tx, fund, req.date);
        const commits = await commitments(tx, fund.id);
        if (commits.size === 0) throw new UnprocessableEntityException("the fund has no closing yet");
        let total = 0;
        for (const v of commits.values()) total += v;
        const called = await tx.one<{ s: number }>("SELECT COALESCE(SUM(amount), 0) AS s FROM calls WHERE fund_id = ?", [fund.id]);
        const unfunded = total - Number(called!.s);
        if (req.amount > unfunded) {
          throw new UnprocessableEntityException(`call of ${eur(req.amount)} exceeds unfunded commitments of ${eur(unfunded)}`);
        }
        const last = await tx.one<{ n: number }>("SELECT COALESCE(MAX(number), 0) AS n FROM calls WHERE fund_id = ?", [fund.id]);
        const number = Number(last!.n) + 1;
        const callId = uuid();
        const dueDate = addBusinessDays(req.date, fund.notice_days);
        await tx.run("INSERT INTO calls (id, tenant_id, fund_id, number, call_date, due_date, amount, purpose) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
          callId, tenant, fund.id, number, req.date, dueDate, req.amount, req.purpose,
        ]);
        const investors = await fundInvestors(tx, fund.id);
        const keys = keyMaps(investors);
        const split = keys.unkey(allocate(req.amount, keys.rekey(commits)));
        const out: CallResult["notices"] = [];
        for (const inv of investors) {
          const share = split.get(inv.id) ?? 0;
          if (share === 0) continue;
          await tx.run("INSERT INTO call_shares (call_id, investor_id, tenant_id, fund_id, amount) VALUES (?, ?, ?, ?, ?)", [callId, inv.id, tenant, fund.id, share]);
          const n = await this.notices.issue(tx, fund, inv, {
            kind: "call",
            sourceId: callId,
            sourceNumber: number,
            gross: share,
            interest: 0,
            dueDate,
            issuedOn: req.date,
            title: `Capital call ${number}`,
            lines: [`Call ${number} of ${eur(req.amount)} on ${req.date} for ${req.purpose.replace("_", " ")}.`],
          });
          out.push({ investorId: inv.id, share, creditApplied: n.credit_applied, amountDue: n.amount_due, reference: n.reference });
        }
        return { callId, number, date: req.date, dueDate, amount: req.amount, notices: out };
      }),
    );
  }
}
