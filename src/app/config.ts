import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";

export interface FundDefaults {
  currency: string;
  eq_rate_bps: number;
  eq_interest_to: "rebalanced_investors" | "fund";
  pref_bps: number;
  carry_bps: number;
  min_ticket: number;
  max_ticket: number;
  notice_days: number;
  grace_days: number;
}

export interface EngineConfig {
  server: { port: number; dispatch_interval_ms: number; dispatch_batch: number };
  auth: { issuer: string; audience: string; tenant_claim: string };
  fund_defaults: FundDefaults;
  matching: { iban_fallback: boolean };
  outbox: { max_attempts: number; lease_seconds: number; lookup_before_retry: boolean; from: string };
  sendgrid: { base_url: string; timeout_ms: number };
}

export function loadConfig(path = process.env.CCE_CONFIG ?? join(process.cwd(), "config", "engine.toml")): EngineConfig {
  return parse(readFileSync(path, "utf8")) as unknown as EngineConfig;
}

/** Overrides used by the evaluation's ablations; each one switches off a single safeguard. */
export type Ablation = "no_iban_fallback" | "blind_retry";

export function withAblation(c: EngineConfig, a: Ablation | null): EngineConfig {
  if (a === "no_iban_fallback") return { ...c, matching: { ...c.matching, iban_fallback: false } };
  if (a === "blind_retry") return { ...c, outbox: { ...c.outbox, lookup_before_retry: false } };
  return c;
}
