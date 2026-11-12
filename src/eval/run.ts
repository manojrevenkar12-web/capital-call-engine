import { INestApplication } from "@nestjs/common";
import { createApp } from "../app/app.module";
import { signToken } from "../app/auth/auth";
import { Ablation, loadConfig, withAblation } from "../app/config";
import { Db } from "../app/db/db";
import { MailError } from "../app/outbox/mailer";
import { OutboxService, ProcessCrash } from "../app/outbox/outbox.service";
import { addBusinessDays, addDays, days, isWeekend } from "../domain/dates";
import { Booking, camt053 } from "../world/bank";
import { renderSubscription } from "../world/documents";
import { SimProvider } from "../world/provider";
import { Rng } from "../world/rng";
import { fundTruth, FundTruth } from "../world/truth";
import { Behaviour, generate, loadWorldConfig, World, WorldFund, WorldInvestor } from "../world/world";

/**
 * Plays one world against the real service: HTTP requests for everything a fund manager
 * does, camt.053 files for the bank, the simulated provider for e-mail, and investors who
 * read their notices and pay (or don't). A simulated operator works the review queues,
 * using what a person could find out (who actually sent a payment). Then every number the
 * engine holds is compared with the answer key.
 */

const SECRET = "eval-secret-not-for-production";

export interface RunOptions {
  seed: number;
  ablation: Ablation | null;
  databaseUrl: string;
  log?: (s: string) => void;
  /** For the demo export: the operator stops working the queues after this date. */
  operatorStopsAt?: string;
  onFinish?: (ctx: { get: (token: string, path: string) => Promise<any>; funds: { id: string; token: string; tenant: string }[] }) => Promise<void>;
}

interface FundState {
  w: WorldFund;
  id: string;
  token: string;
  idOf: Map<string, string>; // world investor key -> engine investor id
  keyOf: Map<string, string>; // engine investor id -> world investor key
  byEmail: Map<string, WorldInvestor>;
  bookings: Booking[];
  delivered: number; // bookings already put on a statement
  lastStatement: string | null;
  seq: number;
  payableSeen: Map<string, number>;
  paidKeys: Set<string>;
  docs: { key: string; needsReview: boolean; engine: string; fieldsRight: boolean | null }[];
}

export async function runSeed(o: RunOptions) {
  const log = o.log ?? (() => undefined);
  const started = Date.now();
  const world: World = generate(o.seed, loadWorldConfig());
  const wc = world.config;
  const rng = new Rng(o.seed * 104729 + 7);

  const dbName = `cce_eval_${o.seed}_${o.ablation ?? "full"}`;
  const admin = new Db(o.databaseUrl.replace(/\/[^/]*$/, "/mysql"));
  await admin.all(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.all(`CREATE DATABASE ${dbName}`);
  await admin.close();
  const db = new Db(o.databaseUrl.replace(/\/[^/]*$/, `/${dbName}`));
  await db.migrate();

  const provider = new SimProvider(rng.fork(1), wc.provider, (k, m) => new MailError(k, m));
  process.env.CCE_JWT_SECRET = SECRET;
  const config = withAblation(loadConfig(), o.ablation);
  const app: INestApplication = await createApp({ db, config, mailer: provider });
  await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  const outbox = app.get(OutboxService);
  const latencies: Record<string, number[]> = { closing: [], call: [], distribution: [], statement: [] };

  const api = async (token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const xml = typeof body === "string";
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": xml ? "application/xml" : "application/json", ...headers },
      body: body === undefined ? undefined : xml ? (body as string) : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return { status: res.status, body: json, replayed: res.headers.get("idempotent-replayed") === "true" };
  };
  const timed = async <T>(kind: string, fn: () => Promise<T>) => {
    const t = performance.now();
    const r = await fn();
    latencies[kind].push(performance.now() - t);
    return r;
  };
  const expectOk = (r: { status: number; body: unknown }, what: string) => {
    if (r.status >= 300) throw new Error(`${what} failed ${r.status}: ${JSON.stringify(r.body)}`);
  };

  const tokens = new Map<string, string>();
  const tokenFor = (tenant: string) => {
    if (!tokens.has(tenant)) {
      tokens.set(tenant, signToken({ iss: config.auth.issuer, aud: config.auth.audience, sub: `ops@${tenant}`, exp: Math.floor(Date.now() / 1000) + 86_400, tenantId: tenant }, SECRET));
    }
    return tokens.get(tenant)!;
  };

  const counters = {
    duplicateRequests: 0, replays: 0, replayBodiesEqual: 0, statementResends: 0,
    operatorPaymentActions: 0, operatorDocumentActions: 0, crashes: 0, duplicatePayments: 0,
  };

  const states: FundState[] = [];
  for (const w of world.funds) {
    const token = tokenFor(w.tenant);
    const r = await api(token, "POST", "/v1/funds", {
      code: w.code, name: w.name, accountIban: w.accountIban,
      eqRateBps: w.terms.eqRateBps, prefBps: w.terms.prefBps, carryBps: w.terms.carryBps,
      noticeDays: w.terms.noticeDays, graceDays: w.terms.graceDays, minTicket: w.terms.minTicket, maxTicket: w.terms.maxTicket,
    });
    expectOk(r, "create fund");
    states.push({
      w, id: r.body.id, token, idOf: new Map(), keyOf: new Map(), byEmail: new Map(w.investors.map((i) => [i.email, i])),
      bookings: [], delivered: 0, lastStatement: null, seq: 0, payableSeen: new Map(), paidKeys: new Set(), docs: [],
    });
  }

  /** Sends a request, sometimes twice at once as a retrying client would; both must come back as one. */
  const maybeTwice = async (s: FundState, kind: string, path: string, body: unknown, key: string) => {
    if (rng.chance(wc.requests.duplicate)) {
      counters.duplicateRequests += 1;
      const [a, b] = await Promise.all([
        api(s.token, "POST", path, body, { "idempotency-key": key }),
        api(s.token, "POST", path, body, { "idempotency-key": key }),
      ]);
      expectOk(a, kind);
      expectOk(b, kind);
      const replay = a.replayed ? a : b;
      if (a.replayed || b.replayed) counters.replays += 1;
      if (JSON.stringify(a.body) === JSON.stringify(b.body)) counters.replayBodiesEqual += 1;
      return replay === a ? b : a;
    }
    const r = await timed(kind, () => api(s.token, "POST", path, body, { "idempotency-key": key }));
    expectOk(r, kind);
    return r;
  };

  const book = (s: FundState, b: Omit<Booking, "entryRef">) => {
    s.seq += 1;
    s.bookings.push({ ...b, entryRef: `${s.w.code}-${b.date.replace(/-/g, "")}-${String(s.seq).padStart(5, "0")}` });
  };
  const nextBusiness = (d: string, n: number) => addBusinessDays(d, n);

  /** An investor reads a notice and decides how to pay it. */
  const react = (s: FundState, inv: WorldInvestor, today: string, m: { key: string; body: string; subject: string }, duplicate: boolean) => {
    const due = m.body.match(/Amount due: EUR ([\d,]+\.\d{2})/);
    const ref = m.body.match(/Reference: (RF\w+)/);
    const dueDate = m.body.match(/Due date: (\d{4}-\d{2}-\d{2})/);
    if (!due || !ref || !dueDate) return;
    const amount = Math.round(Number(due[1].replace(/,/g, "")) * 100);
    if (amount <= 0) return;
    const title = m.subject.split(" — ")[0];
    const call = title.match(/^Capital call (\d+)$/);
    const close = title.match(/^Closing (\d+) equalisation notice$/);
    if (!call && !close) return;
    const noticeKey = `${s.w.key}|${call ? "call" : "catch_up"}|${call ? call[1] : close![1]}|${inv.key}`;
    const intent = { kind: "investor" as const, investorKey: inv.key, noticeKey, reference: ref[1] };
    const base = { credit: true, debtorName: inv.name, debtorIban: inv.iban, structuredRef: ref[1], unstructured: null, intent };
    if (duplicate) {
      if (rng.chance(0.3)) {
        counters.duplicatePayments += 1;
        book(s, { ...base, date: nextBusiness(today, rng.int(1, 4)), amount });
      }
      return;
    }
    const idx = s.payableSeen.get(inv.key) ?? 0;
    s.payableSeen.set(inv.key, idx + 1);
    if (inv.defaultsOn === idx) return;
    const b: Behaviour = rng.weighted(wc.behaviour as Record<Behaviour, number>);
    const day = nextBusiness(today, rng.int(1, 8));
    const grace = s.w.terms.graceDays;
    switch (b) {
      case "on_time": book(s, { ...base, date: day, amount }); break;
      case "reference_in_text": {
        const spaced = ref[1].replace(/(.{4})/g, "$1 ").trim();
        book(s, { ...base, structuredRef: null, unstructured: `Capital call ${spaced} ${inv.name}`, date: day, amount });
        break;
      }
      case "no_reference": book(s, { ...base, structuredRef: null, unstructured: `Kapitalabruf ${s.w.name}`, date: day, amount }); break;
      case "wrong_reference": {
        const r = ref[1];
        const broken = r.slice(0, -1) + String((Number(r.slice(-1)) + 1) % 10);
        book(s, { ...base, structuredRef: broken, date: day, amount });
        break;
      }
      case "partial": {
        const first = Math.round(amount * 0.6);
        book(s, { ...base, date: day, amount: first });
        book(s, { ...base, date: nextBusiness(day, rng.int(2, 5)), amount: amount - first });
        break;
      }
      case "late_within_grace": {
        const options = Array.from({ length: grace }, (_, i) => addDays(dueDate[1], i + 1)).filter((d) => !isWeekend(d));
        book(s, { ...base, date: options.length ? rng.pick(options) : dueDate[1], amount });
        break;
      }
      case "very_late": book(s, { ...base, date: nextBusiness(addDays(dueDate[1], grace), rng.int(2, 12)), amount }); break;
      case "overpay": book(s, { ...base, date: day, amount: amount + 100_00 }); break;
      case "other_account": book(s, { ...base, debtorIban: inv.otherIban, structuredRef: null, unstructured: `Zahlung ${inv.name}`, date: day, amount }); break;
    }
  };

  const otherName = (s: FundState) => world.funds.find((f) => f !== s.w)?.name ?? "Another Fund I";
  let seenMail = 0;
  const end = addDays(world.end, 45);
  let now = world.start;

  while (now <= end) {
    const business = !isWeekend(now);
    for (const s of states) {
      // 1. The morning statement: everything booked before today.
      if (business) {
        const due = s.bookings.filter((b, i) => i >= 0 && b.date < now);
        const fresh = due.slice(0);
        const unsent = fresh.filter((b) => !(b as Booking & { sent?: boolean }).sent);
        if (unsent.length) {
          const xml = camt053(`${s.w.code}-${now}`, s.w.accountIban, now, unsent);
          const r = await timed("statement", () => api(s.token, "POST", "/v1/statements", xml));
          expectOk(r, "statement");
          for (const b of unsent) (b as Booking & { sent?: boolean }).sent = true;
          if (s.lastStatement && rng.chance(wc.bank.statement_resend)) {
            counters.statementResends += 1;
            expectOk(await api(s.token, "POST", "/v1/statements", s.lastStatement), "resent statement");
          }
          s.lastStatement = xml;
        }
        // The operator works the payment review queue with what a person can find out.
        const review = await api(s.token, "GET", `/v1/funds/${s.id}/review/payments`);
        if (review.body.length && !(o.operatorStopsAt && now > o.operatorStopsAt)) {
          const notices = (await api(s.token, "GET", `/v1/funds/${s.id}/notices`)).body as { id: string; reference: string | null; amountDue: number; paid: number }[];
          const byRef = new Map(notices.filter((n) => n.reference).map((n) => [n.reference!, n]));
          for (const e of review.body) {
            const b = s.bookings.find((x) => x.entryRef === e.entry_ref);
            counters.operatorPaymentActions += 1;
            const n = b?.intent.kind === "investor" ? byRef.get(b.intent.reference) : undefined;
            if (n && n.amountDue - n.paid > 0 && !e.notice_id) {
              const r = await api(s.token, "POST", `/v1/bank-entries/${e.id}/resolve`, { action: "apply", noticeId: n.id });
              expectOk(r, "apply entry");
              if (r.body.status === "review") expectOk(await api(s.token, "POST", `/v1/bank-entries/${e.id}/resolve`, { action: "refund", note: "excess returned" }), "refund rest");
            } else {
              expectOk(await api(s.token, "POST", `/v1/bank-entries/${e.id}/resolve`, { action: "refund", note: b?.intent.kind === "investor" ? "already paid; returned" : "not an investor payment" }), "refund entry");
            }
          }
        }
        // Bank noise: interest credits and fees on the account.
        if (rng.chance(wc.bank.noise_credits_per_month / 21)) {
          book(s, { date: now, credit: true, amount: rng.int(100, 90_000), debtorName: "Bank interest", debtorIban: null, structuredRef: null, unstructured: "Habenzinsen", intent: { kind: "noise" } });
        }
        if (rng.chance(wc.bank.fees_per_month / 21)) {
          book(s, { date: now, credit: false, amount: rng.int(500, 5_000), debtorName: null, debtorIban: null, structuredRef: null, unstructured: "Kontofuehrung", intent: { kind: "fee" } });
        }
        expectOk(await api(s.token, "POST", `/v1/funds/${s.id}/sweep`, { asOf: now }), "sweep");
      }

      // 2. The fund's own events for today.
      for (const c of s.w.closings.filter((x) => x.date === now)) {
        const entries: unknown[] = [];
        for (const key of c.admitted) {
          const inv = s.w.investors.find((i) => i.key === key)!;
          const doc = renderSubscription(s.w, inv, otherName(s));
          const r = await api(s.token, "POST", `/v1/funds/${s.id}/documents`, { text: doc.text });
          expectOk(r, "document");
          const f = r.body.fields;
          const right = f.investorName === inv.name && f.commitment === inv.commitment && f.iban === inv.iban && f.email === inv.email;
          s.docs.push({ key, needsReview: doc.needsReview, engine: r.body.status, fieldsRight: r.body.status === "accepted" ? right : null });
          if (r.body.status === "review") {
            counters.operatorDocumentActions += 1;
            const fix = await api(s.token, "POST", `/v1/documents/${r.body.id}/resolve`, { investorName: inv.name, commitment: inv.commitment, iban: inv.iban, email: inv.email });
            expectOk(fix, "resolve document");
          }
          entries.push({ documentId: r.body.id });
        }
        for (const inc of c.increases) entries.push({ investorId: s.idOf.get(inc.key)!, increase: inc.amount });
        const r = await maybeTwice(s, "closing", `/v1/funds/${s.id}/closings`, { date: c.date, entries }, `close-${s.w.code}-${c.number}`);
        c.admitted.forEach((key, i) => {
          s.idOf.set(key, r.body.admitted[i].investorId);
          s.keyOf.set(r.body.admitted[i].investorId, key);
        });
      }
      for (const call of s.w.calls.filter((x) => x.date === now)) {
        await maybeTwice(s, "call", `/v1/funds/${s.id}/calls`, { date: call.date, amount: call.amount, purpose: call.purpose }, `call-${s.w.code}-${call.number}`);
      }
      for (const d of s.w.distributions.filter((x) => x.date === now)) {
        await maybeTwice(s, "distribution", `/v1/funds/${s.id}/distributions`, { date: d.date, amount: d.amount }, `dist-${s.w.code}-${d.number}`);
      }
    }

    // 3. The outbox worker runs through the day; sometimes the process dies mid-send.
    let clock = new Date(`${now}T09:00:00Z`).getTime();
    for (let round = 0; round < 12; round++) {
      try {
        const r = await outbox.dispatch(new Date(clock), {
          afterSend: () => {
            if (rng.chance(wc.provider.crash_after_send)) {
              counters.crashes += 1;
              throw new ProcessCrash("killed");
            }
          },
        });
        if (r.claimed === 0) break;
      } catch (e) {
        if (!(e instanceof ProcessCrash)) throw e;
      }
      clock += (config.outbox.lease_seconds + 5) * 1000;
    }

    // 4. Investors read what arrived.
    const fresh = provider.delivered.slice(seenMail);
    seenMail = provider.delivered.length;
    const seenKeys = new Set(provider.delivered.slice(0, seenMail - fresh.length).map((m) => m.key));
    for (const m of fresh) {
      const s = states.find((x) => x.byEmail.has(m.to));
      if (!s) continue;
      const dup = seenKeys.has(m.key);
      seenKeys.add(m.key);
      react(s, s.byEmail.get(m.to)!, now, m, dup);
    }
    now = addDays(now, 1);
  }

  // Cross-tenant probes: every one must look like the fund does not exist.
  let probes = 0;
  let probesRefused = 0;
  for (const s of states) {
    for (const other of states.filter((x) => x.w.tenant !== s.w.tenant)) {
      for (const [m, p, b] of [
        ["GET", `/v1/funds/${other.id}`, undefined],
        ["GET", `/v1/funds/${other.id}/capital-accounts`, undefined],
        ["GET", `/v1/funds/${other.id}/notices`, undefined],
        ["GET", `/v1/funds/${other.id}/review/payments`, undefined],
        ["GET", `/v1/funds/${other.id}/documents`, undefined],
        ["GET", `/v1/funds/${other.id}/timeline`, undefined],
        ["POST", `/v1/funds/${other.id}/calls`, { date: "2099-01-01", amount: 100, purpose: "investment" }],
        ["POST", `/v1/funds/${other.id}/sweep`, { asOf: "2099-01-01" }],
      ] as const) {
        probes += 1;
        const r = await api(s.token, m, p, b);
        if (r.status === 404) probesRefused += 1;
      }
    }
  }

  const report = await score(db, states, provider, counters, latencies, { probes, probesRefused }, end);
  if (o.onFinish) {
    await o.onFinish({
      get: async (token, path) => (await api(token, "GET", path)).body,
      funds: states.map((s) => ({ id: s.id, token: s.token, tenant: s.w.tenant })),
    });
  }
  await app.close();
  await db.close();
  const admin2 = new Db(o.databaseUrl.replace(/\/[^/]*$/, "/mysql"));
  await admin2.all(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin2.close();
  log(`seed ${o.seed} ${o.ablation ?? "full"} done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  return { seed: o.seed, ablation: o.ablation, seconds: Math.round((Date.now() - started) / 1000), ...report };
}

function p95(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] * 10) / 10;
}

async function score(
  db: Db,
  states: FundState[],
  provider: SimProvider,
  counters: Record<string, number>,
  latencies: Record<string, number[]>,
  tenancy: { probes: number; probesRefused: number },
  lastSweep: string,
) {
  const r = {
    funds: states.length, investors: 0, closings: 0, calls: 0, distributions: 0,
    documents: { submitted: 0, accepted: 0, review: 0, neededReview: 0, caught: 0, missed: 0, unneeded: 0, acceptedWrong: 0 },
    commitments: { checked: 0, right: 0 },
    shares: { checked: 0, right: 0, centsOff: 0 },
    equalisation: { checked: 0, right: 0, catchUp: 0, interest: 0 },
    notices: { expected: 0, right: 0, missing: 0, extra: 0 },
    delivery: { notices: 0, exactlyOnce: 0, never: 0, twiceOrMore: 0, failedForReview: 0 },
    payments: { investorEntries: 0, autoRight: 0, autoWrong: 0, toReview: 0, noise: 0, noiseAuto: 0 },
    cash: { credited: 0, appliedToNotices: 0, refundedOrHeld: 0, unaccounted: 0 },
    defaults: { truth: 0, flagged: 0, missed: 0, falseFlags: 0 },
    waterfall: { distributions: 0, tiersRight: 0, sharesChecked: 0, sharesRight: 0 },
    idempotency: { duplicateRequests: counters.duplicateRequests, replays: counters.replays, sameBody: counters.replayBodiesEqual, extraEvents: 0 },
    tenancy,
    faults: { providerAttempts: provider.attempts, ...provider.faults, crashes: counters.crashes, statementResends: counters.statementResends, duplicatePayments: counters.duplicatePayments },
    operator: { paymentActions: counters.operatorPaymentActions, documentActions: counters.operatorDocumentActions },
    examples: { autoWrong: [] as unknown[], falseFlags: [] as unknown[], missedDefaults: [] as unknown[] },
    latencyMsP95: Object.fromEntries(Object.entries(latencies).map(([k, v]) => [k, p95(v)])),
  };

  for (const s of states) {
    const t: FundTruth = fundTruth(s.w);
    const w = s.w;
    r.investors += w.investors.length;
    r.closings += w.closings.length;
    r.calls += w.calls.length;
    r.distributions += w.distributions.length;
    const keyOf = s.keyOf;

    for (const d of s.docs) {
      r.documents.submitted += 1;
      if (d.engine === "accepted") r.documents.accepted += 1;
      else r.documents.review += 1;
      if (d.needsReview) {
        r.documents.neededReview += 1;
        if (d.engine === "review") r.documents.caught += 1;
        else r.documents.missed += 1;
      } else if (d.engine === "review") r.documents.unneeded += 1;
      if (d.fieldsRight === false) r.documents.acceptedWrong += 1;
    }

    const commits = await db.all("SELECT investor_id, SUM(amount) AS s FROM commitments WHERE fund_id = ? GROUP BY investor_id", [s.id]);
    const cm = new Map(commits.map((c) => [keyOf.get(c.investor_id)!, Number(c.s)]));
    for (const [k, v] of t.commitments) {
      r.commitments.checked += 1;
      if (cm.get(k) === v) r.commitments.right += 1;
    }

    const shares = await db.all("SELECT c.number, s.investor_id, s.amount FROM call_shares s JOIN calls c ON c.id = s.call_id WHERE s.fund_id = ?", [s.id]);
    const sh = new Map<string, number>(shares.map((x) => [`${x.number}|${keyOf.get(x.investor_id)}`, Number(x.amount)]));
    for (const [callNo, m] of t.shares) {
      for (const [k, v] of m) {
        if (v === 0 && !sh.has(`${callNo}|${k}`)) continue;
        r.shares.checked += 1;
        const got = sh.get(`${callNo}|${k}`) ?? 0;
        if (got === v) r.shares.right += 1;
        r.shares.centsOff += Math.abs(got - v);
      }
    }

    const changes = await db.all(
      `SELECT cl.number, sc.investor_id, SUM(GREATEST(sc.delta,0)) AS cu, SUM(GREATEST(-sc.delta,0)) AS rb, SUM(sc.interest_paid) AS ip, SUM(sc.interest_received) AS ir
         FROM share_changes sc JOIN closings cl ON cl.id = sc.closing_id WHERE sc.fund_id = ? GROUP BY cl.number, sc.investor_id`,
      [s.id],
    );
    const ch = new Map(changes.map((x) => [`${x.number}|${keyOf.get(x.investor_id)}`, x]));
    for (const [closeNo, m] of t.equalisation) {
      for (const [k, v] of m) {
        r.equalisation.checked += 1;
        const g = ch.get(`${closeNo}|${k}`);
        const ok = g && Number(g.cu) === v.catchUp && Number(g.rb) === v.rebalance && Number(g.ip) === v.interestPaid && Number(g.ir) === v.interestReceived;
        if (ok) r.equalisation.right += 1;
        r.equalisation.catchUp += v.catchUp;
        r.equalisation.interest += v.interestPaid;
      }
    }

    const notices = await db.all(
      `SELECT n.id, n.kind, n.investor_id, n.gross, n.interest, n.credit_applied, n.amount_due, n.status, n.due_date, n.reference,
              COALESCE(c.number, cl.number, d.number) AS num, o.idempotency_key, o.status AS ostatus
         FROM notices n LEFT JOIN calls c ON c.id = n.source_id LEFT JOIN closings cl ON cl.id = n.source_id
         LEFT JOIN distributions d ON d.id = n.source_id LEFT JOIN outbox o ON o.notice_id = n.id
        WHERE n.fund_id = ?`,
      [s.id],
    );
    const engineNotices = new Map<string, (typeof notices)[number]>();
    for (const n of notices.filter((x) => x.kind !== "reminder")) engineNotices.set(`${w.key}|${n.kind}|${n.num}|${keyOf.get(n.investor_id)}`, n);
    for (const tn of t.notices) {
      r.notices.expected += 1;
      const n = engineNotices.get(tn.key);
      if (!n) {
        r.notices.missing += 1;
        continue;
      }
      if (Number(n.gross) === tn.gross && Number(n.interest) === tn.interest && Number(n.credit_applied) === tn.creditApplied && Number(n.amount_due) === tn.due) r.notices.right += 1;
    }
    r.notices.extra += [...engineNotices.keys()].filter((k) => !t.notices.some((x) => x.key === k)).length;

    const counts = new Map<string, number>();
    for (const m of provider.delivered) counts.set(m.key, (counts.get(m.key) ?? 0) + 1);
    for (const n of notices) {
      r.delivery.notices += 1;
      const c = counts.get(n.idempotency_key) ?? 0;
      if (c === 1) r.delivery.exactlyOnce += 1;
      else if (c === 0) r.delivery.never += 1;
      else r.delivery.twiceOrMore += 1;
      if (n.ostatus === "failed") r.delivery.failedForReview += 1;
    }

    const entries = await db.all("SELECT entry_ref, amount, match_kind, notice_id, status, applied, unapplied FROM bank_entries WHERE fund_id = ?", [s.id]);
    const byRef = new Map(entries.map((e) => [e.entry_ref, e]));
    const noticeIdByRef = new Map(notices.filter((n) => n.reference).map((n) => [n.reference, n.id]));
    const sent = s.bookings.filter((b) => (b as Booking & { sent?: boolean }).sent);
    for (const b of sent) {
      if (!b.credit) continue;
      r.cash.credited += b.amount;
      const e = byRef.get(b.entryRef);
      if (b.intent.kind === "noise") {
        r.payments.noise += 1;
        if (e && e.status === "applied") r.payments.noiseAuto += 1;
        continue;
      }
      if (b.intent.kind !== "investor") continue;
      r.payments.investorEntries += 1;
      if (!e) continue;
      if (["reference", "reference_in_text", "iban_amount", "iban_single"].includes(e.match_kind)) {
        if (e.notice_id === noticeIdByRef.get(b.intent.reference)) r.payments.autoRight += 1;
        else {
          r.payments.autoWrong += 1;
          if (r.examples.autoWrong.length < 5) {
            const got = notices.find((n) => n.id === e.notice_id);
            r.examples.autoWrong.push({ entry: b.entryRef, match: e.match_kind, amount: b.amount, meant: b.intent.noticeKey, got: got ? `${got.kind} ${got.num} due ${got.amount_due}` : null, structuredRef: b.structuredRef, text: b.unstructured });
          }
        }
        if (e.unapplied > 0) r.payments.toReview += 1;
      } else r.payments.toReview += 1;
    }
    const applied = entries.reduce((a, e) => a + Number(e.applied), 0);
    const held = entries.filter((e) => e.status !== "ignored").reduce((a, e) => a + Number(e.unapplied), 0);
    const noticePaid = (await db.one("SELECT COALESCE(SUM(paid),0) AS p FROM notices WHERE fund_id = ?", [s.id]))!.p;
    r.cash.appliedToNotices += applied;
    r.cash.refundedOrHeld += held;
    r.cash.unaccounted += Math.abs(Number(noticePaid) - applied);
    const creditedIn = entries.filter((e) => e.status !== "ignored").reduce((a, e) => a + Number(e.amount), 0);
    r.cash.unaccounted += Math.abs(creditedIn - applied - held);

    // Defaults: a notice should be declared in default when its full payment was booked after due date + grace, or never.
    const flaggedRows = await db.all("SELECT source_id FROM notices WHERE fund_id = ? AND kind = 'reminder'", [s.id]);
    const flagged = new Set(flaggedRows.map((x) => x.source_id));
    for (const tn of t.notices.filter((x) => x.kind !== "distribution" && x.due > 0)) {
      const n = engineNotices.get(tn.key);
      if (!n) continue;
      const pays = sent.filter((b) => b.intent.kind === "investor" && b.intent.noticeKey === tn.key).sort((a, b) => (a.date < b.date ? -1 : 1));
      let cum = 0;
      let fullOn: string | null = null;
      for (const p of pays) {
        cum += p.amount;
        if (cum >= tn.due) {
          fullOn = p.date;
          break;
        }
      }
      const deadline = addDays(tn.dueDate!, w.terms.graceDays);
      const shouldFlag = (fullOn === null || fullOn > deadline) && days(deadline, lastSweep) > 0;
      const did = flagged.has(n.id);
      if (shouldFlag) r.defaults.truth += 1;
      if (shouldFlag && did) r.defaults.flagged += 1;
      if (shouldFlag && !did) r.defaults.missed += 1;
      if (!shouldFlag && did) {
        r.defaults.falseFlags += 1;
        if (r.examples.falseFlags.length < 5) r.examples.falseFlags.push({ notice: tn.key, due: tn.due, dueDate: tn.dueDate, deadline, pays: pays.map((p) => [p.date, p.amount, p.entryRef]) });
      }
      if (shouldFlag && !did && r.examples.missedDefaults.length < 5) r.examples.missedDefaults.push({ notice: tn.key, deadline, fullOn });
    }

    const dists = await db.all("SELECT number, tiers FROM distributions WHERE fund_id = ?", [s.id]);
    for (const d of dists) {
      r.waterfall.distributions += 1;
      const tt = t.tiers.get(d.number);
      if (tt && JSON.stringify(sortKeys(JSON.parse(d.tiers))) === JSON.stringify(sortKeys(tt))) r.waterfall.tiersRight += 1;
    }
    for (const tn of t.notices.filter((x) => x.kind === "distribution")) {
      r.waterfall.sharesChecked += 1;
      const n = engineNotices.get(tn.key);
      if (n && Number(n.gross) === tn.gross) r.waterfall.sharesRight += 1;
    }

    for (const [tbl, n] of [["closings", w.closings.length], ["calls", w.calls.length], ["distributions", w.distributions.length]] as const) {
      const c = (await db.one(`SELECT COUNT(*) AS c FROM ${tbl} WHERE fund_id = ?`, [s.id]))!.c;
      r.idempotency.extraEvents += Math.max(0, Number(c) - n);
    }
  }
  return r;
}

function sortKeys(o: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
}

