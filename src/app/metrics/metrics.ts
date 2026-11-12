import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from "@nestjs/common";
import { Counter, Histogram, Registry } from "prom-client";
import { Observable, tap } from "rxjs";
import { METRICS } from "../tokens";

/** Prometheus metrics. One registry per app instance so tests and the evaluation never share counters. */
export class Metrics {
  readonly registry = new Registry();
  readonly notices = new Counter({ name: "cce_notices_issued_total", help: "Notices issued", labelNames: ["kind"], registers: [this.registry] });
  readonly sends = new Counter({ name: "cce_outbox_sends_total", help: "Outbox send outcomes", labelNames: ["outcome"], registers: [this.registry] });
  readonly matches = new Counter({ name: "cce_bank_entries_total", help: "Bank entries by match", labelNames: ["kind"], registers: [this.registry] });
  readonly reviews = new Counter({ name: "cce_review_items_total", help: "Items sent to a person", labelNames: ["source"], registers: [this.registry] });
  readonly http = new Histogram({
    name: "cce_http_request_seconds",
    help: "HTTP request duration",
    labelNames: ["route", "method", "status"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });
}

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(@Inject(METRICS) private readonly metrics: Metrics) {}
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    const res = ctx.switchToHttp().getResponse();
    const end = this.metrics.http.startTimer({ method: req.method, route: req.route?.path ?? "unknown" });
    return next.handle().pipe(
      tap({ next: () => end({ status: res.statusCode }), error: (e) => end({ status: e?.status ?? 500 }) }),
    );
  }
}
