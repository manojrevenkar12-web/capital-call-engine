import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseIntPipe, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { Public, Subject, Tenant } from "./auth/auth";
import { CallsService } from "./calls/calls.service";
import { ClosingsService } from "./closings/closings.service";
import { Db } from "./db/db";
import { DistributionsService } from "./distributions/distributions.service";
import { DocumentsService } from "./documents/documents.service";
import { FundsService } from "./funds/funds.service";
import { Metrics } from "./metrics/metrics";
import { OutboxService } from "./outbox/outbox.service";
import { StatementsService } from "./payments/statements.service";
import { DB, METRICS } from "./tokens";

/** Replayed idempotent requests answer 200 with the stored body; first runs answer 201. */
function reply<T>(res: Response, r: { replayed: boolean; body: T }): T {
  res.status(r.replayed ? 200 : 201);
  res.setHeader("Idempotent-Replayed", String(r.replayed));
  return r.body;
}

@Controller("v1/funds")
export class FundsController {
  constructor(
    @Inject(FundsService) private readonly funds: FundsService,
    @Inject(ClosingsService) private readonly closings: ClosingsService,
    @Inject(CallsService) private readonly calls: CallsService,
    @Inject(DistributionsService) private readonly distributions: DistributionsService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(StatementsService) private readonly statements: StatementsService,
  ) {}

  @Post() create(@Tenant() t: string, @Body() b: unknown) { return this.funds.create(t, b); }
  @Get() list(@Tenant() t: string) { return this.funds.list(t); }
  @Get(":id") get(@Tenant() t: string, @Param("id") id: string) { return this.funds.summary(t, id); }
  @Get(":id/capital-accounts") accounts(@Tenant() t: string, @Param("id") id: string) { return this.funds.capitalAccounts(t, id); }
  @Get(":id/notices") notices(@Tenant() t: string, @Param("id") id: string, @Query("investorId") inv?: string) { return this.funds.notices(t, id, inv); }
  @Get(":id/closings/:number/equalisation")
  equalisation(@Tenant() t: string, @Param("id") id: string, @Param("number", ParseIntPipe) n: number) { return this.funds.equalisation(t, id, n); }
  @Get(":id/timeline") timeline(@Tenant() t: string, @Param("id") id: string) { return this.funds.timeline(t, id); }

  @Post(":id/documents")
  submit(@Tenant() t: string, @Param("id") id: string, @Body() b: { text?: string }) { return this.documents.submit(t, id, b?.text ?? ""); }
  @Get(":id/documents") docs(@Tenant() t: string, @Param("id") id: string, @Query("status") s?: string) { return this.documents.list(t, id, s); }

  @Post(":id/closings")
  async close(@Tenant() t: string, @Param("id") id: string, @Body() b: unknown, @Headers("idempotency-key") k: string | undefined, @Res({ passthrough: true }) res: Response) {
    return reply(res, await this.closings.close(t, id, b, k));
  }
  @Post(":id/calls")
  async call(@Tenant() t: string, @Param("id") id: string, @Body() b: unknown, @Headers("idempotency-key") k: string | undefined, @Res({ passthrough: true }) res: Response) {
    return reply(res, await this.calls.call(t, id, b, k));
  }
  @Post(":id/distributions")
  async distribute(@Tenant() t: string, @Param("id") id: string, @Body() b: unknown, @Headers("idempotency-key") k: string | undefined, @Res({ passthrough: true }) res: Response) {
    return reply(res, await this.distributions.distribute(t, id, b, k));
  }
  @Post(":id/sweep") @HttpCode(200) sweep(@Tenant() t: string, @Param("id") id: string, @Body() b: unknown) { return this.funds.sweep(t, id, b); }
  @Get(":id/review/payments") reviewPayments(@Tenant() t: string, @Param("id") id: string) { return this.statements.review(t, id); }
}

@Controller("v1")
export class OperationsController {
  constructor(
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(StatementsService) private readonly statements: StatementsService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  @Post("documents/:id/resolve") @HttpCode(200)
  resolveDocument(@Tenant() t: string, @Subject() who: string, @Param("id") id: string, @Body() b: unknown) { return this.documents.resolve(t, id, b, who); }

  /** camt.053 XML as the raw body (Content-Type: application/xml). */
  @Post("statements") @HttpCode(200)
  ingest(@Tenant() t: string, @Req() req: Request) {
    return this.statements.ingest(t, typeof req.body === "string" ? req.body : "");
  }
  @Post("bank-entries/:id/resolve") @HttpCode(200)
  resolveEntry(@Tenant() t: string, @Subject() who: string, @Param("id", ParseIntPipe) id: number, @Body() b: unknown) { return this.statements.resolve(t, id, b, who); }

  @Post("outbox/dispatch") @HttpCode(200)
  dispatch() { return this.outbox.dispatch(); }
}

@Controller()
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  @Public() @Get("healthz") health() { return { status: "ok" }; }

  @Public() @Get("readyz")
  async ready() {
    await this.db.one("SELECT 1 AS ok");
    return { status: "ready" };
  }

  @Public() @Get("metrics")
  async scrape(@Res() res: Response) {
    res.setHeader("content-type", this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}
