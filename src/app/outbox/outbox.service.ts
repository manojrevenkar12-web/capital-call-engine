import { Inject, Injectable } from "@nestjs/common";
import { EngineConfig } from "../config";
import { Db } from "../db/db";
import { Metrics } from "../metrics/metrics";
import { CONFIG, DB, MAILER, METRICS } from "../tokens";
import { Mailer, MailError } from "./mailer";

/** Thrown by the evaluation's fault hook to stand in for the process dying mid-send. */
export class ProcessCrash extends Error {}

export interface DispatchHooks {
  afterSend?: (key: string) => void;
}

export interface DispatchResult {
  claimed: number;
  confirmed: number;
  confirmedByLookup: number;
  retryLater: number;
  failed: number;
}

interface OutboxRow {
  id: number;
  recipient: string;
  subject: string;
  body: string;
  idempotency_key: string;
  attempts: number;
  last_outcome: "none" | "not_sent" | "ambiguous";
}

/**
 * Sends what the outbox holds. A message is claimed with a lease (several workers never
 * send the same row at once), marked 'ambiguous' before the call goes out (a crash leaves
 * it ambiguous), and only marked confirmed when the provider accepts it or says it already
 * has it. A notice reaches an investor once, not zero times and not twice.
 */
@Injectable()
export class OutboxService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: EngineConfig,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  async dispatch(now: Date = new Date(), hooks: DispatchHooks = {}, batch = this.config.server.dispatch_batch): Promise<DispatchResult> {
    const leaseUntil = new Date(now.getTime() + this.config.outbox.lease_seconds * 1000);
    const claimed = await this.db.tx(async (tx) => {
      const rows = await tx.all<OutboxRow>(
        `SELECT id, recipient, subject, body, idempotency_key, attempts, last_outcome FROM outbox
          WHERE status = 'pending' AND attempts < ? AND (lease_until IS NULL OR lease_until < ?)
          ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED`,
        [this.config.outbox.max_attempts, now, batch],
      );
      if (rows.length) {
        await tx.run(
          `UPDATE outbox SET lease_until = ?, attempts = attempts + 1, last_outcome = 'ambiguous' WHERE id IN (${rows.map(() => "?").join(",")})`,
          [leaseUntil, ...rows.map((r) => r.id)],
        );
      }
      return rows;
    });
    const out: DispatchResult = { claimed: claimed.length, confirmed: 0, confirmedByLookup: 0, retryLater: 0, failed: 0 };
    for (const row of claimed) {
      const done = (status: string, outcome: string, providerId: string | null, error: string | null) =>
        this.db.all(
          "UPDATE outbox SET status = ?, last_outcome = ?, provider_id = COALESCE(?, provider_id), last_error = ?, lease_until = NULL WHERE id = ?",
          [status, outcome, providerId, error, row.id],
        );
      if (row.last_outcome === "ambiguous" && this.config.outbox.lookup_before_retry) {
        try {
          const found = await this.mailer.lookup(row.idempotency_key);
          if (found) {
            await done("confirmed", "none", found, null);
            out.confirmedByLookup += 1;
            this.metrics.sends.inc({ outcome: "confirmed_by_lookup" });
            continue;
          }
        } catch (e) {
          await done("pending", "ambiguous", null, `lookup: ${(e as Error).message}`.slice(0, 300));
          out.retryLater += 1;
          continue;
        }
      }
      try {
        const r = await this.mailer.send({ idempotencyKey: row.idempotency_key, to: row.recipient, subject: row.subject, body: row.body });
        hooks.afterSend?.(row.idempotency_key);
        await done("confirmed", "none", r.providerId, null);
        out.confirmed += 1;
        this.metrics.sends.inc({ outcome: "confirmed" });
      } catch (e) {
        if (e instanceof ProcessCrash) throw e;
        const kind = e instanceof MailError ? e.kind : "ambiguous";
        const lastAttempt = row.attempts + 1 >= this.config.outbox.max_attempts;
        if (kind === "permanent" || lastAttempt) {
          await done("failed", kind === "ambiguous" ? "ambiguous" : "not_sent", null, (e as Error).message.slice(0, 300));
          out.failed += 1;
          this.metrics.sends.inc({ outcome: "failed" });
          this.metrics.reviews.inc({ source: "outbox" });
        } else {
          await done("pending", kind === "not_sent" ? "not_sent" : "ambiguous", null, (e as Error).message.slice(0, 300));
          out.retryLater += 1;
          this.metrics.sends.inc({ outcome: kind });
        }
      }
    }
    return out;
  }
}
