import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSeed } from "../src/eval/run";
import { addDays } from "../src/domain/dates";
import { generate } from "../src/world/world";

/**
 * Writes the dashboard's demo data: one fund manager from world seed 9 run through the
 * real service, read back over the API, plus the evaluation reports. The operator stops
 * working the queues 25 days before the end so the dashboard has open review items.
 */
const SEED = 9;
const out = join(__dirname, "..", "web", "public", "demo");
const url = process.env.CCE_DATABASE_URL ?? "mysql://root@127.0.0.1:3307/cce";

async function main() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const w = generate(SEED);
  const write = (p: string, data: unknown) => {
    mkdirSync(join(out, p, ".."), { recursive: true });
    writeFileSync(join(out, p), JSON.stringify(data));
  };
  await runSeed({
    seed: SEED,
    ablation: null,
    databaseUrl: url,
    operatorStopsAt: addDays(w.end, -25),
    log: (s) => process.stderr.write(`${s}\n`),
    onFinish: async ({ get, funds }) => {
      const tenant = funds[0].tenant;
      const mine = funds.filter((f) => f.tenant === tenant);
      const token = mine[0].token;
      write("funds.json", await get(token, "/v1/funds"));
      for (const f of mine) {
        const base = `/v1/funds/${f.id}`;
        write(`funds/${f.id}/accounts.json`, await get(token, `${base}/capital-accounts`));
        const timeline = await get(token, `${base}/timeline`);
        write(`funds/${f.id}/timeline.json`, timeline);
        write(`funds/${f.id}/notices.json`, await get(token, `${base}/notices`));
        write(`funds/${f.id}/review.json`, await get(token, `${base}/review/payments`));
        write(`funds/${f.id}/documents.json`, await get(token, `${base}/documents?status=review`));
        for (const c of timeline.filter((e: { type: string }) => e.type === "closing")) {
          write(`funds/${f.id}/closings/${c.number}.json`, await get(token, `${base}/closings/${c.number}/equalisation`));
        }
      }
    },
  });
  const reports = join(__dirname, "..", "reports");
  const heldout = join(reports, "heldout", "first_run.json");
  write("report.json", {
    dev: JSON.parse(readFileSync(join(reports, "dev.json"), "utf8")),
    heldout: existsSync(heldout) ? JSON.parse(readFileSync(heldout, "utf8")) : null,
  });
  process.stderr.write(`wrote ${out}\n`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
