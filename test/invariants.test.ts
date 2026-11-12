import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchEntry } from "../src/domain/matching";
import { checkEqualisation, equalise } from "../src/domain/equalisation";
import { contribute, distribute, emptyWaterfall } from "../src/domain/waterfall";
import { allocate } from "../src/money/money";
import { rfReference } from "../src/domain/identifiers";
import { fundTruth } from "../src/world/truth";
import { generate } from "../src/world/world";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const root = join(__dirname, "..");

describe("invariants", () => {
  it("nothing that serves reads the truth", () => {
    for (const f of [...files(join(root, "src/app")), ...files(join(root, "src/domain")), ...files(join(root, "src/money"))]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/from ["'][./]*(world|eval)\//);
    }
  });

  it("the world does not read the service", () => {
    for (const f of files(join(root, "src/world"))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/from ["'][./]*app\//);
    }
  });
});

describe("engine arithmetic against the answer key on generated funds", () => {
  it("call shares, equalisation and the waterfall agree for 40 funds", () => {
    let funds = 0;
    for (let seed = 500; funds < 40; seed++) {
      for (const f of generate(seed).funds) {
        if (funds >= 40) break;
        funds += 1;
        const truth = fundTruth(f);
        const commits = new Map<string, number>();
        const shares = new Map<number, Map<string, number>>();
        let wf = emptyWaterfall();
        const terms = { prefBps: f.terms.prefBps, carryBps: f.terms.carryBps };
        type Ev = { date: string; order: number; run: () => void };
        const evs: Ev[] = [
          ...f.closings.map((c) => ({ date: c.date, order: 0, run: () => {
            for (const k of c.admitted) commits.set(k, f.investors.find((i) => i.key === k)!.commitment);
            for (const inc of c.increases) commits.set(inc.key, commits.get(inc.key)! + inc.amount);
            if (shares.size === 0) return;
            const calls = [...shares.entries()].map(([n, m]) => ({ id: String(n), date: f.calls[n - 1].date, amount: f.calls[n - 1].amount, funded: m }));
            const eq = equalise(commits, calls, c.date, { rateBps: f.terms.eqRateBps, interestTo: "rebalanced_investors" });
            expect(checkEqualisation(eq)).toEqual([]);
            for (const ce of eq.calls) shares.set(Number(ce.callId), ce.target);
            for (const [k, t] of truth.equalisation.get(c.number)!) {
              expect(eq.catchUp.get(k) ?? 0).toBe(t.catchUp);
              expect(eq.interestDue.get(k) ?? 0).toBe(t.interestPaid);
              expect(eq.interestCredit.get(k) ?? 0).toBe(t.interestReceived);
            }
          } })),
          ...f.calls.map((c) => ({ date: c.date, order: 1, run: () => {
            shares.set(c.number, allocate(c.amount, commits));
            wf = contribute(wf, c.date, c.amount, terms);
          } })),
          ...f.distributions.map((d) => ({ date: d.date, order: 3, run: () => {
            const r = distribute(wf, d.date, d.amount, terms);
            wf = r.state;
            expect(r.tiers).toEqual(truth.tiers.get(d.number));
          } })),
        ];
        evs.sort((a, b) => (a.date === b.date ? a.order - b.order : a.date < b.date ? -1 : 1));
        for (const e of evs) e.run();
        for (const [n, m] of truth.shares) for (const [k, v] of m) expect(shares.get(n)!.get(k) ?? 0).toBe(v);
      }
    }
    expect(funds).toBe(40);
  });
});

describe("matching safeguards", () => {
  it("sends a valid reference paid from another investor's known account to a person", () => {
    const ref = rfReference("AB1C1N1");
    const notices = [{ noticeId: "n1", investorId: "a", reference: ref, outstanding: 100 }];
    const entry = {
      statementId: "s", account: "x", entryRef: "e", amount: 100, currency: "EUR", credit: true, bookingDate: "2025-01-01",
      valueDate: "2025-01-01", debtorName: null, debtorIban: "DE00B", structuredRef: ref, unstructured: null,
    };
    expect(matchEntry(entry, "EUR", notices, new Map([["DE00B", ["b"]]]), { ibanFallback: true }).kind).toBe("review");
    expect(matchEntry(entry, "EUR", notices, new Map([["DE00B", ["a"]]]), { ibanFallback: true }).kind).toBe("reference");
    expect(matchEntry({ ...entry, debtorIban: "DE00UNKNOWN" }, "EUR", notices, new Map(), { ibanFallback: true }).kind).toBe("reference");
  });
});
