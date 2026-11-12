import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { isValidIban, normaliseIban } from "../../domain/identifiers";
import { readSubscription, SubscriptionFields } from "../../domain/subscription";
import { parse, readFund, uuid } from "../common/common";
import { Db, isDuplicate } from "../db/db";
import { Metrics } from "../metrics/metrics";
import { DB, METRICS } from "../tokens";

export interface DocumentView {
  id: string;
  status: "accepted" | "review" | "resolved" | "used";
  fields: SubscriptionFields;
  problems: string[];
}

export const resolveSchema = z.object({
  investorName: z.string().min(2).max(200),
  commitment: z.number().int().positive().safe(),
  iban: z.string().min(15).max(40),
  email: z.string().email(),
});

/**
 * Subscription documents come in as text (from the e-signature tool or OCR). Code reads
 * them and decides; a person resolves what code would not accept. Only accepted or
 * resolved documents can become commitments at a closing.
 */
@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  async submit(tenant: string, fundId: string, body: string): Promise<DocumentView & { duplicate: boolean }> {
    if (!body || body.length > 200_000) throw new BadRequestException("document text is empty or too long");
    return this.db.tx(async (tx) => {
      const fund = await readFund(tx, tenant, fundId);
      const sha = createHash("sha256").update(body).digest("hex");
      const reading = readSubscription(body, { fundName: fund.name, minTicket: fund.min_ticket, maxTicket: fund.max_ticket });
      const id = uuid();
      const status = reading.decision === "accept" ? "accepted" : "review";
      try {
        await tx.run(
          "INSERT INTO documents (id, tenant_id, fund_id, content_sha, body, fields, problems, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [id, tenant, fund.id, sha, body, JSON.stringify(reading.fields), JSON.stringify(reading.problems), status],
        );
      } catch (e) {
        if (!isDuplicate(e)) throw e;
        const existing = await tx.one("SELECT id FROM documents WHERE fund_id = ? AND content_sha = ?", [fund.id, sha]);
        return { ...(await this.view(tenant, existing!.id, tx)), duplicate: true };
      }
      if (status === "review") this.metrics.reviews.inc({ source: "document" });
      return { id, status, fields: reading.fields, problems: reading.problems, duplicate: false };
    });
  }

  async resolve(tenant: string, documentId: string, raw: unknown, reviewer: string): Promise<DocumentView> {
    const f = parse(resolveSchema, raw);
    const iban = normaliseIban(f.iban);
    if (!isValidIban(iban)) throw new BadRequestException("IBAN fails its check digits");
    return this.db.tx(async (tx) => {
      const doc = await tx.one("SELECT * FROM documents WHERE id = ? AND tenant_id = ? FOR UPDATE", [documentId, tenant]);
      if (!doc) throw new NotFoundException("document not found");
      if (doc.status !== "review") throw new ConflictException(`document is ${doc.status}`);
      const fund = await readFund(tx, tenant, doc.fund_id);
      if (f.commitment < fund.min_ticket || f.commitment > fund.max_ticket) throw new BadRequestException("commitment outside the fund's ticket limits");
      const fields: SubscriptionFields = { investorName: f.investorName, commitment: f.commitment, commitmentInWords: null, iban, email: f.email.toLowerCase(), fundName: fund.name };
      await tx.run("UPDATE documents SET status = 'resolved', fields = ?, resolved_by = ? WHERE id = ?", [JSON.stringify(fields), reviewer, documentId]);
      return { id: documentId, status: "resolved", fields, problems: JSON.parse(doc.problems) };
    });
  }

  async view(tenant: string, id: string, tx?: { one: Db["one"] }): Promise<DocumentView> {
    const q = tx ?? this.db;
    const d = await q.one("SELECT id, status, fields, problems FROM documents WHERE id = ? AND tenant_id = ?", [id, tenant]);
    if (!d) throw new NotFoundException("document not found");
    return { id: d.id, status: d.status, fields: JSON.parse(d.fields), problems: JSON.parse(d.problems) };
  }

  async list(tenant: string, fundId: string, status?: string): Promise<DocumentView[]> {
    await this.db.tx((tx) => readFund(tx, tenant, fundId));
    const rows = await this.db.all(
      `SELECT id, status, fields, problems FROM documents WHERE tenant_id = ? AND fund_id = ? ${status ? "AND status = ?" : ""} ORDER BY id`,
      status ? [tenant, fundId, status] : [tenant, fundId],
    );
    return rows.map((d) => ({ id: d.id, status: d.status, fields: JSON.parse(d.fields), problems: JSON.parse(d.problems) }));
  }
}
