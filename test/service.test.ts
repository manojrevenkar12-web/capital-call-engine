import { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app/app.module";
import { signToken } from "../src/app/auth/auth";
import { loadConfig, withAblation } from "../src/app/config";
import { Db } from "../src/app/db/db";
import { Mailer, MailError } from "../src/app/outbox/mailer";
import { OutboxService, ProcessCrash } from "../src/app/outbox/outbox.service";
import { ibanFor } from "../src/domain/identifiers";
import { camt053 } from "../src/world/bank";

/**
 * Runs the service against a real MySQL. CI provides one; locally start it with
 * scripts/mysql-local.sh. These tests fail rather than skip when MySQL is missing.
 */

const URL = process.env.CCE_DATABASE_URL ?? "mysql://root@127.0.0.1:3307/cce";
const SECRET = "test-secret";
const config = loadConfig();

class FlakyMailer implements Mailer {
  delivered = new Map<string, number>();
  failNext = 0;
  async send(m: { idempotencyKey: string }) {
    this.delivered.set(m.idempotencyKey, (this.delivered.get(m.idempotencyKey) ?? 0) + 1);
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new MailError("ambiguous", "timeout after accept");
    }
    return { providerId: `p-${m.idempotencyKey}` };
  }
  async lookup(key: string) {
    return this.delivered.has(key) ? `p-${key}` : null;
  }
}

let db: Db;
let app: INestApplication;
let base: string;
const mailer = new FlakyMailer();
const token = (tenant: string, extra: Record<string, unknown> = {}) =>
  signToken({ iss: config.auth.issuer, aud: config.auth.audience, sub: "t", exp: Math.floor(Date.now() / 1000) + 600, tenantId: tenant, ...extra }, SECRET);

async function call(t: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const xml = typeof body === "string";
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${t}`, "content-type": xml ? "application/xml" : "application/json", ...headers },
    body: body === undefined ? undefined : xml ? (body as string) : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const A = token("alpha");
const B = token("beta");
const form = (name: string, euros: number, n: number) =>
  `Fund: Test Fund I\nName of Subscriber: ${name}\nCapital Commitment: EUR ${euros.toLocaleString("en-US")}.00\nIBAN: ${ibanFor("DE", `1005000000000000${String(n).padStart(2, "0")}`)}\nE-mail: lp${n}@example.com`;

async function fund(t: string, code: string, accountSuffix: string) {
  const r = await call(t, "POST", "/v1/funds", { code, name: "Test Fund I", accountIban: ibanFor("DE", `20050000${accountSuffix.padStart(10, "0")}`) });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

async function admit(t: string, fundId: string, date: string, investors: [string, number, number][], key: string) {
  const ids: string[] = [];
  for (const [name, euros, n] of investors) {
    const d = await call(t, "POST", `/v1/funds/${fundId}/documents`, { text: form(name, euros, n) });
    expect(d.body.status).toBe("accepted");
    ids.push(d.body.id);
  }
  return call(t, "POST", `/v1/funds/${fundId}/closings`, { date, entries: ids.map((documentId) => ({ documentId })) }, { "idempotency-key": key });
}

beforeAll(async () => {
  const admin = new Db(URL.replace(/\/[^/]*$/, "/mysql"));
  await admin.all("DROP DATABASE IF EXISTS cce_test");
  await admin.all("CREATE DATABASE cce_test");
  await admin.close();
  db = new Db(URL.replace(/\/[^/]*$/, "/cce_test"));
  await db.migrate();
  process.env.CCE_JWT_SECRET = SECRET;
  app = await createApp({ db, config, mailer });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
});

afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe("auth and tenancy", () => {
  it("rejects missing, forged and expired tokens", async () => {
    expect((await fetch(`${base}/v1/funds`)).status).toBe(401);
    expect((await call(signToken({ iss: config.auth.issuer, aud: config.auth.audience, exp: 9e9, tenantId: "alpha" }, "wrong"), "GET", "/v1/funds")).status).toBe(401);
    expect((await call(token("alpha", { exp: 1 }), "GET", "/v1/funds")).status).toBe(401);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it("answers 404 for another manager's fund on every route", async () => {
    const id = await fund(A, "TEN1", "1");
    for (const [m, p, b] of [
      ["GET", `/v1/funds/${id}`, undefined],
      ["GET", `/v1/funds/${id}/capital-accounts`, undefined],
      ["GET", `/v1/funds/${id}/notices`, undefined],
      ["GET", `/v1/funds/${id}/timeline`, undefined],
      ["GET", `/v1/funds/${id}/documents`, undefined],
      ["GET", `/v1/funds/${id}/review/payments`, undefined],
      ["POST", `/v1/funds/${id}/documents`, { text: "x" }],
      ["POST", `/v1/funds/${id}/calls`, { date: "2025-01-01", amount: 100, purpose: "investment" }],
      ["POST", `/v1/funds/${id}/sweep`, { asOf: "2025-01-01" }],
    ] as const) {
      expect((await call(B, m, p, b)).status, `${m} ${p}`).toBe(404);
    }
    expect((await call(B, "GET", "/v1/funds")).body).toEqual([]);
  });
});

describe("calls, closings and idempotency", () => {
  it("turns two concurrent identical requests into one call", async () => {
    const id = await fund(A, "IDM1", "2");
    expect((await admit(A, id, "2025-01-06", [["Elbe GmbH", 1_000_000, 1], ["Havel AG", 3_000_000, 2]], "close-idm-1")).status).toBe(201);
    const body = { date: "2025-02-03", amount: 400_000_00, purpose: "investment" };
    const [x, y] = await Promise.all([
      call(A, "POST", `/v1/funds/${id}/calls`, body, { "idempotency-key": "call-idm-0001" }),
      call(A, "POST", `/v1/funds/${id}/calls`, body, { "idempotency-key": "call-idm-0001" }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 201]);
    expect(x.body).toEqual(y.body);
    expect((await call(A, "POST", `/v1/funds/${id}/calls`, { ...body, amount: 1 }, { "idempotency-key": "call-idm-0001" })).status).toBe(422);
    const summary = await call(A, "GET", `/v1/funds/${id}`);
    expect(summary.body.calls).toBe(1);
    expect(summary.body.called).toBe(400_000_00);
  });

  it("serialises different concurrent calls and refuses a back-dated one", async () => {
    const id = await fund(A, "SER1", "3");
    await admit(A, id, "2025-01-06", [["Spree KG", 2_000_000, 3], ["Isar AG", 2_000_000, 4]], "close-ser-1");
    const rs = await Promise.all(
      [1, 2, 3, 4].map((i) => call(A, "POST", `/v1/funds/${id}/calls`, { date: "2025-03-03", amount: 100_000_00 + i, purpose: "investment" }, { "idempotency-key": `call-ser-000${i}` })),
    );
    expect(rs.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(rs.map((r) => r.body.number).sort()).toEqual([1, 2, 3, 4]);
    for (const r of rs) expect(r.body.notices.reduce((a: number, n: { share: number }) => a + n.share, 0)).toBe(r.body.amount);
    const back = await call(A, "POST", `/v1/funds/${id}/calls`, { date: "2025-02-01", amount: 100, purpose: "investment" });
    expect(back.status).toBe(409);
    const over = await call(A, "POST", `/v1/funds/${id}/calls`, { date: "2025-03-04", amount: 4_000_000_00, purpose: "investment" });
    expect(over.status).toBe(422);
  });

  it("equalises a second closing and nets the credit against the next call", async () => {
    const id = await fund(A, "EQ1", "4");
    await admit(A, id, "2025-01-06", [["Main GmbH", 7_000_000, 5]], "close-eq-1");
    await call(A, "POST", `/v1/funds/${id}/calls`, { date: "2025-01-10", amount: 1_400_000_00, purpose: "investment" });
    const c2 = await admit(A, id, "2025-10-07", [["Rhein AG", 3_000_000, 6]], "close-eq-2");
    expect(c2.status).toBe(201);
    expect(c2.body.equalisation.catchUp).toBe(420_000_00);
    const accounts = (await call(A, "GET", `/v1/funds/${id}/capital-accounts`)).body;
    const [first, second] = accounts;
    expect(first.called + second.called).toBe(1_400_000_00);
    expect(second.called).toBe(420_000_00);
    expect(first.creditBalance).toBe(420_000_00 + second.interestPaid);
    const next = await call(A, "POST", `/v1/funds/${id}/calls`, { date: "2025-11-03", amount: 1_000_000_00, purpose: "investment" });
    const firstNotice = next.body.notices.find((n: { investorId: string }) => n.investorId === first.investorId);
    expect(firstNotice.creditApplied).toBe(420_000_00 + second.interestPaid);
    expect(firstNotice.amountDue).toBe(700_000_00 - firstNotice.creditApplied);
  });
});

describe("statements and the outbox", () => {
  it("applies a payment once even when the statement arrives twice", async () => {
    const id = await fund(A, "PAY1", "5");
    await admit(A, id, "2025-01-06", [["Neckar GmbH", 1_000_000, 7]], "close-pay-1");
    const c = await call(A, "POST", `/v1/funds/${id}/calls`, { date: "2025-02-03", amount: 100_000_00, purpose: "investment" });
    const n = c.body.notices[0];
    const f = (await call(A, "GET", `/v1/funds/${id}`)).body;
    const xml = camt053("ST-1", f.accountIban, "2025-02-06", [{
      entryRef: "E-1", date: "2025-02-05", amount: n.amountDue, credit: true, debtorName: "Neckar GmbH", debtorIban: null,
      structuredRef: n.reference, unstructured: null, intent: { kind: "noise" },
    }]);
    expect((await call(A, "POST", "/v1/statements", xml)).body.applied).toBe(1);
    expect((await call(A, "POST", "/v1/statements", xml)).body.duplicates).toBe(1);
    const acc = (await call(A, "GET", `/v1/funds/${id}/capital-accounts`)).body[0];
    expect(acc.paid).toBe(n.amountDue);
    expect(acc.outstanding).toBe(0);
    expect((await call(B, "POST", "/v1/statements", xml)).status).toBe(422);
  });

  it("asks the provider before resending after a crash or a timeout", async () => {
    const outbox = app.get(OutboxService);
    while ((await outbox.dispatch()).claimed > 0);
    const id = await fund(A, "OUT1", "6");
    await admit(A, id, "2025-01-06", [["Saale GmbH", 1_000_000, 8], ["Weser AG", 1_000_000, 9]], "close-out-1");
    await call(A, "POST", `/v1/funds/${id}/calls`, { date: "2025-02-03", amount: 50_000_00, purpose: "investment" });
    const t0 = new Date("2030-01-01T10:00:00Z");
    await expect(outbox.dispatch(t0, { afterSend: () => { throw new ProcessCrash("killed"); } })).rejects.toThrow(ProcessCrash);
    // Still leased: nothing happens until the lease runs out.
    expect((await outbox.dispatch(new Date(t0.getTime() + 1000))).claimed).toBe(0);
    mailer.failNext = 1;
    const later = new Date(t0.getTime() + (config.outbox.lease_seconds + 1) * 1000);
    const r1 = await outbox.dispatch(later);
    expect(r1.confirmedByLookup).toBe(1);
    const r2 = await outbox.dispatch(new Date(later.getTime() + 1000));
    expect(r2.confirmedByLookup).toBe(1);
    const keys = (await db.all("SELECT o.idempotency_key, o.status FROM outbox o JOIN notices n ON n.id = o.notice_id WHERE n.fund_id = ?", [id]));
    expect(keys.every((k) => k.status === "confirmed")).toBe(true);
    for (const k of keys) expect(mailer.delivered.get(k.idempotency_key)).toBe(1);
  });

  it("without the lookup a timeout becomes a second e-mail (the ablation)", () => {
    expect(withAblation(config, "blind_retry").outbox.lookup_before_retry).toBe(false);
  });
});
