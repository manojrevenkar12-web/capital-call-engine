import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { isValidIban, normaliseIban } from "../../domain/identifiers";
import { Cents } from "../../money/money";
import { EngineConfig } from "../config";
import { isoDate, lockFund, parse, readFund, uuid } from "../common/common";
import { Db, isDuplicate } from "../db/db";
import { NoticesService } from "../notices/notices.service";
import { CONFIG, DB } from "../tokens";

export const fundSchema = z.object({
  code: z.string().regex(/^[A-Z0-9]{2,6}$/, "2-6 capital letters or digits"),
  name: z.string().min(3).max(200),
  accountIban: z.string(),
  currency: z.string().length(3).optional(),
  eqRateBps: z.number().int().min(0).max(5000).optional(),
  eqInterestTo: z.enum(["rebalanced_investors", "fund"]).optional(),
  prefBps: z.number().int().min(0).max(5000).optional(),
  carryBps: z.number().int().min(0).max(5000).optional(),
  minTicket: z.number().int().positive().safe().optional(),
  maxTicket: z.number().int().positive().safe().optional(),
  noticeDays: z.number().int().min(1).max(60).optional(),
  graceDays: z.number().int().min(0).max(90).optional(),
});

export interface CapitalAccount {
  investorId: string;
  number: number;
  name: string;
  commitment: Cents;
  called: Cents;
  unfunded: Cents;
  catchUp: Cents;
  rebalancingCredit: Cents;
  interestPaid: Cents;
  interestReceived: Cents;
  creditBalance: Cents;
  due: Cents;
  paid: Cents;
  outstanding: Cents;
  distributed: Cents;
  defaulted: boolean;
}

@Injectable()
export class FundsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: EngineConfig,
    @Inject(NoticesService) private readonly noticeService: NoticesService,
  ) {}

  async create(tenant: string, raw: unknown) {
    const r = parse(fundSchema, raw);
    const d = this.config.fund_defaults;
    const iban = normaliseIban(r.accountIban);
    if (!isValidIban(iban)) throw new ConflictException("account IBAN fails its check digits");
    const id = uuid();
    try {
      await this.db.all(
        `INSERT INTO funds (id, tenant_id, code, name, currency, account_iban, eq_rate_bps, eq_interest_to, pref_bps, carry_bps, min_ticket, max_ticket, notice_days, grace_days)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, tenant, r.code, r.name, r.currency ?? d.currency, iban, r.eqRateBps ?? d.eq_rate_bps, r.eqInterestTo ?? d.eq_interest_to,
          r.prefBps ?? d.pref_bps, r.carryBps ?? d.carry_bps, r.minTicket ?? d.min_ticket, r.maxTicket ?? d.max_ticket,
          r.noticeDays ?? d.notice_days, r.graceDays ?? d.grace_days],
      );
    } catch (e) {
      if (isDuplicate(e)) throw new ConflictException("fund code or account already exists");
      throw e;
    }
    return this.summary(tenant, id);
  }

  async list(tenant: string) {
    const funds = await this.db.all<{ id: string }>("SELECT id FROM funds WHERE tenant_id = ? ORDER BY created_at, id", [tenant]);
    return Promise.all(funds.map((f) => this.summary(tenant, f.id)));
  }

  async summary(tenant: string, fundId: string) {
    const f = await this.db.one("SELECT * FROM funds WHERE id = ? AND tenant_id = ?", [fundId, tenant]);
    if (!f) throw new NotFoundException("fund not found");
    const [c] = await this.db.all("SELECT COALESCE(SUM(amount),0) AS committed, COUNT(DISTINCT investor_id) AS investors FROM commitments WHERE fund_id = ?", [fundId]);
    const [k] = await this.db.all("SELECT COALESCE(SUM(amount),0) AS called, COUNT(*) AS calls FROM calls WHERE fund_id = ?", [fundId]);
    const [cl] = await this.db.all("SELECT COUNT(*) AS closings FROM closings WHERE fund_id = ?", [fundId]);
    const [d] = await this.db.all("SELECT COALESCE(SUM(amount),0) AS distributed, COUNT(*) AS distributions FROM distributions WHERE fund_id = ?", [fundId]);
    const [n] = await this.db.all(
      `SELECT COALESCE(SUM(GREATEST(amount_due - paid, 0)),0) AS outstanding,
              SUM(status = 'open') AS open, SUM(status = 'defaulted') AS defaulted
         FROM notices WHERE fund_id = ? AND kind IN ('call','catch_up')`,
      [fundId],
    );
    const [rv] = await this.db.all("SELECT COUNT(*) AS payments FROM bank_entries WHERE fund_id = ? AND status = 'review'", [fundId]);
    const [rd] = await this.db.all("SELECT COUNT(*) AS documents FROM documents WHERE fund_id = ? AND status = 'review'", [fundId]);
    const [ob] = await this.db.all(
      `SELECT SUM(o.status='pending') AS pending, SUM(o.status='failed') AS failed, SUM(o.status='confirmed') AS confirmed
         FROM outbox o JOIN notices x ON x.id = o.notice_id WHERE x.fund_id = ?`,
      [fundId],
    );
    return {
      id: f.id, code: f.code, name: f.name, currency: f.currency, accountIban: f.account_iban,
      terms: { eqRateBps: f.eq_rate_bps, eqInterestTo: f.eq_interest_to, prefBps: f.pref_bps, carryBps: f.carry_bps, noticeDays: f.notice_days, graceDays: f.grace_days, minTicket: Number(f.min_ticket), maxTicket: Number(f.max_ticket) },
      lastEventDate: f.last_event_date,
      committed: Number(c.committed), investors: Number(c.investors), closings: Number(cl.closings),
      called: Number(k.called), calls: Number(k.calls),
      distributed: Number(d.distributed), distributions: Number(d.distributions),
      outstanding: Number(n.outstanding), openNotices: Number(n.open ?? 0), defaultedNotices: Number(n.defaulted ?? 0),
      review: { payments: Number(rv.payments), documents: Number(rd.documents) },
      outbox: { pending: Number(ob.pending ?? 0), failed: Number(ob.failed ?? 0), confirmed: Number(ob.confirmed ?? 0) },
    };
  }

  async capitalAccounts(tenant: string, fundId: string): Promise<CapitalAccount[]> {
    await this.db.tx((tx) => readFund(tx, tenant, fundId));
    const rows = await this.db.all(
      `SELECT i.id, i.number, i.name, i.defaulted,
         (SELECT COALESCE(SUM(amount),0) FROM commitments WHERE investor_id = i.id) AS commitment,
         (SELECT COALESCE(SUM(amount),0) FROM call_shares WHERE investor_id = i.id) AS called,
         (SELECT COALESCE(SUM(GREATEST(delta,0)),0) FROM share_changes WHERE investor_id = i.id) AS catch_up,
         (SELECT COALESCE(SUM(interest_paid),0) FROM share_changes WHERE investor_id = i.id) AS interest_paid,
         (SELECT COALESCE(SUM(interest_received),0) FROM share_changes WHERE investor_id = i.id) AS interest_received,
         (SELECT COALESCE(SUM(amount),0) FROM credits WHERE investor_id = i.id AND kind = 'rebalancing') AS rebalancing,
         (SELECT COALESCE(SUM(amount),0) FROM credits WHERE investor_id = i.id) AS credit_balance,
         (SELECT COALESCE(SUM(amount_due),0) FROM notices WHERE investor_id = i.id AND kind IN ('call','catch_up')) AS due,
         (SELECT COALESCE(SUM(paid),0) FROM notices WHERE investor_id = i.id AND kind IN ('call','catch_up')) AS paid,
         (SELECT COALESCE(SUM(gross),0) FROM notices WHERE investor_id = i.id AND kind = 'distribution') AS distributed
       FROM investors i WHERE i.fund_id = ? AND i.tenant_id = ? ORDER BY i.number`,
      [fundId, tenant],
    );
    return rows.map((r) => ({
      investorId: r.id, number: r.number, name: r.name,
      commitment: Number(r.commitment), called: Number(r.called), unfunded: Number(r.commitment) - Number(r.called),
      catchUp: Number(r.catch_up), rebalancingCredit: Number(r.rebalancing), interestPaid: Number(r.interest_paid),
      interestReceived: Number(r.interest_received), creditBalance: Number(r.credit_balance),
      due: Number(r.due), paid: Number(r.paid), outstanding: Math.max(0, Number(r.due) - Number(r.paid)),
      distributed: Number(r.distributed), defaulted: Boolean(r.defaulted),
    }));
  }

  async notices(tenant: string, fundId: string, investorId?: string) {
    await this.db.tx((tx) => readFund(tx, tenant, fundId));
    return this.db.all(
      `SELECT n.id, n.investor_id AS investorId, i.name AS investorName, n.kind, n.reference, n.gross, n.interest, n.credit_applied AS creditApplied,
              n.amount_due AS amountDue, n.paid, n.due_date AS dueDate, n.status, n.issued_on AS issuedOn,
              (SELECT o.status FROM outbox o WHERE o.notice_id = n.id) AS delivery
         FROM notices n JOIN investors i ON i.id = n.investor_id
        WHERE n.tenant_id = ? AND n.fund_id = ? ${investorId ? "AND n.investor_id = ?" : ""}
        ORDER BY n.issued_on DESC, i.number`,
      investorId ? [tenant, fundId, investorId] : [tenant, fundId],
    );
  }

  /** Events in date order, for the dashboard's fund timeline. */
  async timeline(tenant: string, fundId: string) {
    await this.db.tx((tx) => readFund(tx, tenant, fundId));
    const closings = await this.db.all(
      `SELECT c.id, c.number, c.close_date AS date,
              (SELECT COALESCE(SUM(amount),0) FROM commitments WHERE closing_id = c.id) AS amount,
              (SELECT COALESCE(SUM(GREATEST(delta,0)),0) FROM share_changes WHERE closing_id = c.id) AS catchUp,
              (SELECT COALESCE(SUM(interest_paid),0) FROM share_changes WHERE closing_id = c.id) AS interest
         FROM closings c WHERE c.fund_id = ?`,
      [fundId],
    );
    const calls = await this.db.all("SELECT id, number, call_date AS date, due_date AS dueDate, amount, purpose FROM calls WHERE fund_id = ?", [fundId]);
    const dists = await this.db.all("SELECT id, number, dist_date AS date, amount, to_investors AS toInvestors, to_gp AS toGp, tiers FROM distributions WHERE fund_id = ?", [fundId]);
    const events: { type: string; date: string; [k: string]: unknown }[] = [
      ...closings.map((c) => ({ type: "closing", ...c, amount: Number(c.amount), catchUp: Number(c.catchUp), interest: Number(c.interest) })),
      ...calls.map((c) => ({ type: "call", ...c, amount: Number(c.amount) })),
      ...dists.map((d) => ({ type: "distribution", ...d, amount: Number(d.amount), tiers: JSON.parse(d.tiers) })),
    ] as unknown as { type: string; date: string }[];
    return events.sort((a, b) => (a.date === b.date ? (a.type < b.type ? -1 : 1) : a.date < b.date ? -1 : 1));
  }

  /** Who paid in and who was credited at one closing, per investor, across all earlier calls. */
  async equalisation(tenant: string, fundId: string, closingNumber: number) {
    await this.db.tx((tx) => readFund(tx, tenant, fundId));
    const closing = await this.db.one("SELECT id, number, close_date AS date, interest_to_fund AS interestToFund FROM closings WHERE fund_id = ? AND number = ?", [fundId, closingNumber]);
    if (!closing) throw new NotFoundException("closing not found");
    const rows = await this.db.all(
      `SELECT i.id AS investorId, i.number, i.name,
              SUM(GREATEST(sc.delta, 0)) AS catchUp, SUM(GREATEST(-sc.delta, 0)) AS rebalancing,
              SUM(sc.interest_paid) AS interestPaid, SUM(sc.interest_received) AS interestReceived, COUNT(DISTINCT sc.call_id) AS calls
         FROM share_changes sc JOIN investors i ON i.id = sc.investor_id
        WHERE sc.closing_id = ? GROUP BY i.id, i.number, i.name ORDER BY i.number`,
      [closing.id],
    );
    return {
      number: closing.number,
      date: closing.date,
      interestToFund: Number(closing.interestToFund),
      investors: rows.map((r) => ({
        investorId: r.investorId, number: r.number, name: r.name, calls: Number(r.calls),
        catchUp: Number(r.catchUp), rebalancing: Number(r.rebalancing), interestPaid: Number(r.interestPaid), interestReceived: Number(r.interestReceived),
      })),
    };
  }

  async sweep(tenant: string, fundId: string, raw: unknown) {
    const { asOf } = parse(z.object({ asOf: isoDate }), raw);
    return this.db.tx(async (tx) => {
      const fund = await lockFund(tx, tenant, fundId);
      return this.noticeService.sweep(tx, fund, asOf);
    });
  }
}
