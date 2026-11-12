import { describe, expect, it } from "vitest";
import { allocate, Q } from "../src/money/money";
import { checkEqualisation, equalise } from "../src/domain/equalisation";
import { contribute, distribute, emptyWaterfall } from "../src/domain/waterfall";
import { findRfReferences, ibanFor, isValidIban, isValidRf, rfReference } from "../src/domain/identifiers";
import { eurosToEnglish, eurosToGerman, wordsToEuros } from "../src/domain/numberWords";
import { parseMoney, readSubscription } from "../src/domain/subscription";
import { parseCamt053 } from "../src/domain/camt053";
import { matchEntry } from "../src/domain/matching";

describe("allocate", () => {
  it("always sums to the total and ignores input order", () => {
    const w = new Map<string, number>([["c", 1], ["a", 1], ["b", 1]]);
    const out = allocate(100, w);
    expect([...out.values()].reduce((a, b) => a + b, 0)).toBe(100);
    expect(out.get("a")).toBe(34);
    expect(allocate(100, new Map([["b", 1], ["a", 1], ["c", 1]]))).toEqual(out);
  });
  it("handles commitments whose product overflows a double", () => {
    const big = 9_000_000_000_000;
    const out = allocate(big, new Map([["x", big], ["y", big - 1]]));
    expect(out.get("x")! + out.get("y")!).toBe(big);
  });
});

describe("Q", () => {
  it("floors and rounds negative and positive fractions", () => {
    expect(new Q(-7n, 2n).floor()).toBe(-4);
    expect(new Q(7n, 2n).round()).toBe(4);
    expect(new Q(5n, 2n).floor()).toBe(2);
  });
});

describe("equalisation", () => {
  const terms = { rateBps: 800, interestTo: "rebalanced_investors" as const };

  it("matches the textbook case: 20% called, new LP pays catch-up and 8% interest", () => {
    // First close 70m across two LPs, one call of 14m (20%), new LP commits 30m 270 days later.
    const call = { id: "c1", date: "2025-01-01", amount: 14_000_000_00, funded: new Map([["a", 10_000_000_00], ["b", 4_000_000_00]]) };
    const after = new Map([["a", 50_000_000_00], ["b", 20_000_000_00], ["n", 30_000_000_00]]);
    const e = equalise(after, [call], "2025-09-28", terms);
    expect(e.catchUp.get("n")).toBe(4_200_000_00);
    expect(e.rebalanceCredit.get("a")).toBe(3_000_000_00);
    expect(e.rebalanceCredit.get("b")).toBe(1_200_000_00);
    // 4.2m x 8% x 270/365
    expect(e.interestDue.get("n")).toBe(new Q(4_200_000_00n * 8n * 270n, 100n * 365n).round());
    const got = (e.interestCredit.get("a") ?? 0) + (e.interestCredit.get("b") ?? 0);
    expect(got).toBe(e.interestDue.get("n"));
    expect(checkEqualisation(e)).toEqual([]);
  });

  it("makes a second-close investor a receiver at the third close", () => {
    const c1 = { id: "c1", date: "2025-01-01", amount: 1_000_000, funded: new Map([["a", 1_000_000]]) };
    const second = equalise(new Map([["a", 100], ["b", 100]]), [c1], "2025-03-01", terms);
    const funded2 = second.calls[0].target;
    const third = equalise(new Map([["a", 100], ["b", 100], ["c", 200]]), [{ ...c1, funded: funded2 }], "2025-06-01", terms);
    expect(third.rebalanceCredit.get("b")).toBe(250_000);
    expect(third.catchUp.get("c")).toBe(500_000);
    expect(checkEqualisation(third)).toEqual([]);
  });

  it("refuses shares that do not add up to the call", () => {
    expect(() => equalise(new Map([["a", 1]]), [{ id: "x", date: "2025-01-01", amount: 10, funded: new Map([["a", 9]]) }], "2025-02-01", terms)).toThrow();
  });
});

describe("waterfall", () => {
  const t = { prefBps: 800, carryBps: 2000 };
  it("returns capital, then pref, then catch-up, then 80/20", () => {
    let s = contribute(emptyWaterfall(), "2024-01-01", 1_000_000_00, t);
    const r = distribute(s, "2025-01-01", 2_000_000_00, t);
    s = r.state;
    expect(r.tiers.returnOfCapital).toBe(1_000_000_00);
    // 366 days in 2024
    expect(r.tiers.preferredReturn).toBe(new Q(1_000_000_00n * 8n * 366n, 100n * 365n).floor());
    expect(r.tiers.gpCatchUp).toBe(Math.floor(r.tiers.preferredReturn / 4));
    const totalProfit = r.tiers.preferredReturn + r.tiers.gpCatchUp + r.tiers.splitToInvestors + r.tiers.splitToGp;
    const gp = r.tiers.gpCatchUp + r.tiers.splitToGp;
    expect(Math.abs(gp / totalProfit - 0.2)).toBeLessThan(1e-6);
    expect(s.capitalOutstanding).toBe(0);
  });
});

describe("identifiers", () => {
  it("makes and checks RF references and IBANs", () => {
    const r = rfReference("F1C03L017");
    expect(isValidRf(r)).toBe(true);
    expect(isValidRf(r.slice(0, -1) + "8")).toBe(false);
    expect(isValidRf("RF18539007547034")).toBe(true);
    expect(findRfReferences(`capital call ${r.slice(0, 4)} ${r.slice(4)} thanks`)).toEqual([r]);
    expect(findRfReferences(`${r.slice(0, -1)}X more`)).toEqual([]);
    expect(isValidIban("DE89 3704 0044 0532 0130 00")).toBe(true);
    expect(isValidIban(ibanFor("DE", "370400440532013000"))).toBe(true);
  });
});

describe("amounts in words", () => {
  it("reads English and German and round-trips what the simulator writes", () => {
    expect(wordsToEuros("two million five hundred thousand euros")).toBe(2_500_000);
    expect(wordsToEuros("zwei Millionen fünfhunderttausend Euro")).toBe(2_500_000);
    for (const n of [1, 21, 101, 999_999, 1_250_000, 7_345_678, 20_000_000]) {
      expect(wordsToEuros(eurosToEnglish(n))).toBe(n);
      expect(wordsToEuros(eurosToGerman(n))).toBe(n);
    }
  });
  it("parses money in both conventions and undoes OCR letters", () => {
    expect(parseMoney("EUR 1.250.000,00")).toBe(125_000_000);
    expect(parseMoney("€1,250,000")).toBe(125_000_000);
    expect(parseMoney("1 25O 000,00 EUR")).toBe(125_000_000);
    expect(parseMoney("EUR 12,50,000")).toBeNull();
  });
});

describe("subscription reading", () => {
  const rules = { fundName: "Northwind Ventures II", minTicket: 100_000_00, maxTicket: 50_000_000_00 };
  const iban = ibanFor("DE", "100500001234567890");
  it("accepts a clean form and sends a contradiction to review", () => {
    const form = `Fund: Northwind Ventures II\nName of Subscriber: Elbe Family Office GmbH\nCapital Commitment: EUR 2,500,000.00\nIn words: two million five hundred thousand euros\nIBAN: ${iban}\nE-mail: ops@elbe-fo.de`;
    expect(readSubscription(form, rules).decision).toBe("accept");
    const bad = form.replace("two million five hundred", "two million");
    const r = readSubscription(bad, rules);
    expect(r.decision).toBe("review");
    expect(r.problems).toContain("figures and words disagree");
  });
  it("reads the letter layout", () => {
    const letter = `Dear Sirs,\nWe, Havel Pension Trust, hereby irrevocably commit EUR 1.000.000,00 (one million euros) to Northwind Ventures II.\nOur account: IBAN ${iban}\nNotices to treasury@havel.example`;
    const r = readSubscription(letter, rules);
    expect(r.fields.investorName).toBe("Havel Pension Trust");
    expect(r.decision).toBe("accept");
  });
});

describe("camt.053 and matching", () => {
  const ref = rfReference("F1C01L001");
  const xml = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt><Id>S1</Id><Acct><Id><IBAN>DE02100100100006820101</IBAN></Id></Acct>
  <Ntry><Amt Ccy="EUR">1500.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2025-02-03</Dt></BookgDt><ValDt><Dt>2025-02-03</Dt></ValDt><AcctSvcrRef>E1</AcctSvcrRef>
  <NtryDtls><TxDtls><RltdPties><Dbtr><Pty><Nm>A</Nm></Pty></Dbtr><DbtrAcct><Id><IBAN>DE89370400440532013000</IBAN></Id></DbtrAcct></RltdPties><RmtInf><Strd><CdtrRefInf><Ref>${ref}</Ref></CdtrRefInf></Strd></RmtInf></TxDtls></NtryDtls></Ntry>
  <Ntry><Amt Ccy="EUR">700.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2025-02-03</Dt></BookgDt><AcctSvcrRef>E2</AcctSvcrRef>
  <NtryDtls><TxDtls><RltdPties><DbtrAcct><Id><IBAN>DE89370400440532013000</IBAN></Id></DbtrAcct></RltdPties><RmtInf><Ustrd>capital call</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
  </Stmt></BkToCstmrStmt></Document>`;
  it("parses entries and matches by reference, then by account", () => {
    const [a, b] = parseCamt053(xml);
    expect(a.amount).toBe(150_000);
    const notices = [
      { noticeId: "n1", investorId: "lp1", reference: ref, outstanding: 150_000 },
      { noticeId: "n2", investorId: "lp1", reference: rfReference("F1C02L001"), outstanding: 70_000 },
    ];
    const owners = new Map([["DE89370400440532013000", ["lp1"]]]);
    expect(matchEntry(a, "EUR", notices, owners, { ibanFallback: true })).toEqual({ kind: "reference", noticeId: "n1" });
    expect(matchEntry(b, "EUR", notices, owners, { ibanFallback: true })).toEqual({ kind: "iban_amount", noticeId: "n2" });
    expect(matchEntry(b, "EUR", notices, owners, { ibanFallback: false }).kind).toBe("review");
  });
});
