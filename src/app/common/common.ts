import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { z } from "zod";
import { isDuplicate, Row, Tx } from "../db/db";

export function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new BadRequestException({ message: "invalid request", issues: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  }
  return r.data;
}

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
export const centsSchema = z.number().int().safe();

export interface FundRow extends Row {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  currency: string;
  account_iban: string;
  eq_rate_bps: number;
  eq_interest_to: "rebalanced_investors" | "fund";
  pref_bps: number;
  carry_bps: number;
  min_ticket: number;
  max_ticket: number;
  notice_days: number;
  grace_days: number;
  last_event_date: string | null;
  waterfall_state: string | null;
  contributed_calls: number;
}

/**
 * Locks the fund row for the rest of the transaction. Closings, calls, distributions and
 * payment matching all take this lock, so they see each other's results in order.
 */
export async function lockFund(tx: Tx, tenant: string, fundId: string): Promise<FundRow> {
  const f = await tx.one<FundRow>("SELECT * FROM funds WHERE id = ? AND tenant_id = ? FOR UPDATE", [fundId, tenant]);
  if (!f) throw new NotFoundException("fund not found");
  return f;
}

export async function readFund(tx: Tx, tenant: string, fundId: string): Promise<FundRow> {
  const f = await tx.one<FundRow>("SELECT * FROM funds WHERE id = ? AND tenant_id = ?", [fundId, tenant]);
  if (!f) throw new NotFoundException("fund not found");
  return f;
}

/** Fund events are booked in date order; a back-dated call would silently change equalisation already sent out. */
export async function advanceEventDate(tx: Tx, fund: FundRow, date: string): Promise<void> {
  if (fund.last_event_date && date < fund.last_event_date) {
    throw new ConflictException(`fund has events up to ${fund.last_event_date}; ${date} is earlier`);
  }
  await tx.run("UPDATE funds SET last_event_date = ? WHERE id = ?", [date, fund.id]);
}

/**
 * Stores the response in the same transaction as the effects, so a retried request
 * either finds the finished result or runs as if for the first time, never half.
 * A concurrent duplicate blocks on the key until the first commits, then replays it.
 */
export async function idempotent<T>(
  tx: Tx,
  tenant: string,
  key: string | undefined,
  request: unknown,
  fn: () => Promise<T>,
): Promise<{ replayed: boolean; body: T }> {
  if (!key) return { replayed: false, body: await fn() };
  if (!/^[A-Za-z0-9_.:-]{8,100}$/.test(key)) throw new BadRequestException("Idempotency-Key must be 8-100 safe characters");
  const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  try {
    await tx.run("INSERT INTO idempotency (tenant_id, idem_key, request_hash) VALUES (?, ?, ?)", [tenant, key, hash]);
  } catch (e) {
    if (!isDuplicate(e)) throw e;
    const row = await tx.one("SELECT request_hash, response FROM idempotency WHERE tenant_id = ? AND idem_key = ?", [tenant, key]);
    if (!row || row.request_hash !== hash) throw new UnprocessableEntityException("Idempotency-Key was used for a different request");
    return { replayed: true, body: JSON.parse(row.response) as T };
  }
  const body = await fn();
  await tx.run("UPDATE idempotency SET status_code = 201, response = ? WHERE tenant_id = ? AND idem_key = ?", [
    JSON.stringify(body),
    tenant,
    key,
  ]);
  return { replayed: false, body };
}

export function uuid(): string {
  return crypto.randomUUID();
}
