import { Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { z } from "zod";
import { contribute, deserialise, distribute, investorsShare, serialise, Tiers } from "../../domain/waterfall";
import { allocate, Cents, eur } from "../../money/money";
import { advanceEventDate, idempotent, isoDate, lockFund, parse, uuid } from "../common/common";
import { Db } from "../db/db";
import { fundInvestors, keyMaps, NoticesService } from "../notices/notices.service";
import { DB } from "../tokens";

export const distributionSchema = z.object({ date: isoDate, amount: z.number().int().positive().safe() });

export interface DistributionResult {
  distributionId: string;
  number: number;
  date: string;
  amount: Cents;
  tiers: Tiers;
  toInvestors: Cents;
  toGp: Cents;
  shares: { investorId: string; amount: Cents }[];
}

@Injectable()
export class DistributionsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(NoticesService) private readonly notices: NoticesService,
  ) {}

  async distribute(tenant: string, fundId: string, raw: unknown, key?: string): Promise<{ replayed: boolean; body: DistributionResult }> {
    const req = parse(distributionSchema, raw);
    return this.db.tx((tx) =>
      idempotent(tx, tenant, key, { fundId, req }, async () => {
        const fund = await lockFund(tx, tenant, fundId);
        await advanceEventDate(tx, fund, req.date);
        const terms = { prefBps: fund.pref_bps, carryBps: fund.carry_bps };

        // Bring the fund-level waterfall up to date with every call made since it last ran.
        let state = deserialise(fund.waterfall_state);
        const newCalls = await tx.all<{ number: number; call_date: string; amount: number }>(
          "SELECT number, call_date, amount FROM calls WHERE fund_id = ? AND number > ? ORDER BY number",
          [fund.id, fund.contributed_calls],
        );
        for (const c of newCalls) state = contribute(state, c.call_date, Number(c.amount), terms);
        const contributedCalls = newCalls.length ? newCalls[newCalls.length - 1].number : fund.contributed_calls;

        const r = distribute(state, req.date, req.amount, terms);
        const toInvestors = investorsShare(r.tiers);
        const toGp = r.tiers.gpCatchUp + r.tiers.splitToGp;

        const called = await tx.all<{ investor_id: string; s: number }>(
          "SELECT investor_id, SUM(amount) AS s FROM call_shares WHERE fund_id = ? GROUP BY investor_id HAVING SUM(amount) > 0",
          [fund.id],
        );
        if (called.length === 0) throw new UnprocessableEntityException("nothing has been called, so there is no one to distribute to");
        const investors = await fundInvestors(tx, fund.id);
        const keys = keyMaps(investors);
        const split = keys.unkey(allocate(toInvestors, keys.rekey(new Map(called.map((c) => [c.investor_id, Number(c.s)])))));

        const last = await tx.one<{ n: number }>("SELECT COALESCE(MAX(number), 0) AS n FROM distributions WHERE fund_id = ?", [fund.id]);
        const number = Number(last!.n) + 1;
        const id = uuid();
        await tx.run(
          "INSERT INTO distributions (id, tenant_id, fund_id, number, dist_date, amount, to_investors, to_gp, tiers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [id, tenant, fund.id, number, req.date, req.amount, toInvestors, toGp, JSON.stringify(r.tiers)],
        );
        await tx.run("UPDATE funds SET waterfall_state = ?, contributed_calls = ? WHERE id = ?", [serialise(r.state), contributedCalls, fund.id]);

        const shares: DistributionResult["shares"] = [];
        for (const inv of investors) {
          const amount = split.get(inv.id) ?? 0;
          if (amount === 0) continue;
          await this.notices.issue(tx, fund, inv, {
            kind: "distribution",
            sourceId: id,
            sourceNumber: number,
            gross: amount,
            interest: 0,
            dueDate: null,
            issuedOn: req.date,
            title: `Distribution ${number}`,
            lines: [
              `Distribution ${number} of ${eur(req.amount)} on ${req.date}.`,
              `Return of capital ${eur(r.tiers.returnOfCapital)}, preferred return ${eur(r.tiers.preferredReturn)}, profit split to investors ${eur(r.tiers.splitToInvestors)} (fund level).`,
            ],
          });
          shares.push({ investorId: inv.id, amount });
        }
        return { distributionId: id, number, date: req.date, amount: req.amount, tiers: r.tiers, toInvestors, toGp, shares };
      }),
    );
  }
}
