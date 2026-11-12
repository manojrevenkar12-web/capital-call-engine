import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ablation } from "../src/app/config";
import { runSeed } from "../src/eval/run";

/**
 * dev:      seeds 1-3 with every safeguard, then each ablation on the same seeds
 * --heldout: seeds 101-102, once; refuses to run again
 * --seed N:  one seed, for a quick look
 * --check:   rerun dev and fail if the committed report differs
 */
const DEV = [1, 2, 3];
const HELDOUT = [101, 102];
const ABLATIONS: Ablation[] = ["no_iban_fallback", "blind_retry"];
const url = process.env.CCE_DATABASE_URL ?? "mysql://root@127.0.0.1:3307/cce";
const reports = join(__dirname, "..", "reports");
const log = (s: string) => process.stderr.write(`${s}\n`);

function strip(r: any) {
  const { seconds, latencyMsP95, examples, ...rest } = r;
  void seconds; void latencyMsP95; void examples;
  return rest;
}

function total(runs: any[]) {
  const add = (a: any, b: any): any => {
    if (typeof a === "number" && typeof b === "number") return a + b;
    if (a && typeof a === "object") {
      const out: any = {};
      for (const k of Object.keys(a)) out[k] = add(a[k], b?.[k]);
      return out;
    }
    return a;
  };
  return runs.map(strip).reduce((a, b) => add(a, b));
}

async function main() {
  const args = process.argv.slice(2);
  mkdirSync(join(reports, "heldout"), { recursive: true });
  if (args[0] === "--seed") {
    const r = await runSeed({ seed: Number(args[1]), ablation: (args[2] as Ablation) ?? null, databaseUrl: url, log });
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (args[0] === "--heldout") {
    const path = join(reports, "heldout", "first_run.json");
    if (existsSync(path)) throw new Error(`${path} exists; the held-out seeds run once`);
    const runs = [];
    for (const seed of HELDOUT) runs.push(await runSeed({ seed, ablation: null, databaseUrl: url, log }));
    writeFileSync(path, JSON.stringify({ seeds: HELDOUT, total: total(runs), runs: runs.map(strip), ranAt: new Date().toISOString() }, null, 2) + "\n");
    log(`wrote ${path}`);
    return;
  }
  const full = [];
  for (const seed of DEV) full.push(await runSeed({ seed, ablation: null, databaseUrl: url, log }));
  const ablations: Record<string, unknown> = {};
  for (const a of ABLATIONS) {
    const runs = [];
    for (const seed of DEV) runs.push(await runSeed({ seed, ablation: a, databaseUrl: url, log }));
    ablations[a] = total(runs);
  }
  const report = {
    seeds: DEV,
    total: total(full),
    runs: full.map(strip),
    ablations,
    latencyMsP95: full.map((r) => ({ seed: r.seed, ...r.latencyMsP95 })),
    seconds: full.map((r) => r.seconds),
  };
  const path = join(reports, "dev.json");
  const body = JSON.stringify({ ...report, latencyMsP95: undefined, seconds: undefined }, null, 2) + "\n";
  if (args[0] === "--check") {
    const old = readFileSync(path, "utf8");
    if (old !== body) {
      log("reports/dev.json does not match what the code produces");
      process.exit(1);
    }
    log("dev report matches");
    return;
  }
  writeFileSync(path, body);
  writeFileSync(join(reports, "timing.json"), JSON.stringify({ latencyMsP95: report.latencyMsP95, seconds: report.seconds }, null, 2) + "\n");
  log(`wrote ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
