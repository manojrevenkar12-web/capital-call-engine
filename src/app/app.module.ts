import "reflect-metadata";
import { DynamicModule, INestApplication, Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import express from "express";
import { AuthGuard } from "./auth/auth";
import { CallsService } from "./calls/calls.service";
import { ClosingsService } from "./closings/closings.service";
import { EngineConfig } from "./config";
import { Db } from "./db/db";
import { DistributionsService } from "./distributions/distributions.service";
import { DocumentsService } from "./documents/documents.service";
import { FundsService } from "./funds/funds.service";
import { FundsController, HealthController, OperationsController } from "./http.controllers";
import { HttpMetricsInterceptor, Metrics } from "./metrics/metrics";
import { NoticesService } from "./notices/notices.service";
import { Mailer } from "./outbox/mailer";
import { OutboxService } from "./outbox/outbox.service";
import { StatementsService } from "./payments/statements.service";
import { CONFIG, DB, MAILER, METRICS } from "./tokens";

export interface AppOptions {
  db: Db;
  config: EngineConfig;
  mailer: Mailer;
}

@Module({})
export class AppModule {
  static forRoot(o: AppOptions): DynamicModule {
    return {
      module: AppModule,
      controllers: [FundsController, OperationsController, HealthController],
      providers: [
        { provide: DB, useValue: o.db },
        { provide: CONFIG, useValue: o.config },
        { provide: MAILER, useValue: o.mailer },
        { provide: METRICS, useValue: new Metrics() },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
        NoticesService,
        FundsService,
        DocumentsService,
        ClosingsService,
        CallsService,
        DistributionsService,
        StatementsService,
        OutboxService,
      ],
    };
  }
}

export async function createApp(o: AppOptions): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(o), { logger: ["error", "warn"], bodyParser: false });
  app.use("/v1/statements", express.text({ type: ["application/xml", "text/xml"], limit: "20mb" }));
  app.use(express.json({ limit: "2mb" }));
  app.enableShutdownHooks();
  return app;
}
