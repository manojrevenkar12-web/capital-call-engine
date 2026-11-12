import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { addDays, isWeekend } from "../domain/dates";
import { ibanFor } from "../domain/identifiers";
import { Rng } from "./rng";

/**
 * The simulated world. It decides who the investors are, what each fund does and when,
 * how each investor behaves, and what the bank and the e-mail provider do. The engine
 * only ever sees what a real fund manager's system would see: documents, requests,
 * bank statements and provider responses.
 */

export type WorldConfig = Record<string, any>;

export function loadWorldConfig(path = join(process.cwd(), "config", "world.toml")): WorldConfig {
  return parse(readFileSync(path, "utf8")) as WorldConfig;
}

export type Behaviour =
  | "on_time" | "reference_in_text" | "no_reference" | "wrong_reference" | "partial"
  | "late_within_grace" | "very_late" | "overpay" | "other_account";

export interface DocumentDefects {
  ocr: boolean;
  wordsMissing: boolean;
  wordsDisagree: boolean;
  badIban: boolean;
  misfiled: boolean;
  missingEmail: boolean;
}

export interface WorldInvestor {
  key: string;
  name: string;
  email: string;
  iban: string;
  /** An account the investor sometimes pays from that the fund does not know. */
  otherIban: string;
  admittedAt: number;
  commitment: number;
  /** Which of their payable notices (0-based, in the order received) they never pay, if any. */
  defaultsOn: number | null;
  layout: "en_form" | "de_form" | "letter";
  defects: DocumentDefects;
  seed: number;
}

export interface WorldClosing {
  number: number;
  date: string;
  admitted: string[];
  increases: { key: string; amount: number }[];
}

export interface WorldCall {
  number: number;
  date: string;
  amount: number;
  purpose: "investment" | "management_fee" | "fund_expenses";
}

export interface WorldDistribution {
  number: number;
  date: string;
  amount: number;
}

export interface WorldFund {
  tenant: string;
  key: string;
  code: string;
  name: string;
  accountIban: string;
  terms: { eqRateBps: number; prefBps: number; carryBps: number; noticeDays: number; graceDays: number; minTicket: number; maxTicket: number };
  investors: WorldInvestor[];
  closings: WorldClosing[];
  calls: WorldCall[];
  distributions: WorldDistribution[];
}

export interface World {
  seed: number;
  start: string;
  end: string;
  funds: WorldFund[];
  config: WorldConfig;
}

const FIRST = ["Elbe", "Havel", "Spree", "Isar", "Main", "Rhein", "Mosel", "Neckar", "Saale", "Weser", "Oder", "Lahn", "Ruhr", "Donau", "Inn", "Lech", "Fulda", "Ems", "Aller", "Ilm"];
const KIND = ["Family Office GmbH", "Pension Trust", "Capital Partners", "Holding AG", "Ventures GmbH", "Foundation", "Invest KG", "Beteiligungs GmbH", "Asset Management", "Endowment"];
const FUND_NAMES = ["Northwind Ventures", "Kestrel Growth", "Lindenhof Capital", "Brightwater Seed", "Hafen Partners", "Alder Climate", "Gneisenau Tech", "Moorland Buyout"];

function businessDay(d: string): string {
  let out = d;
  while (isWeekend(out)) out = addDays(out, 1);
  return out;
}

function makeIban(rng: Rng): string {
  const bank = String(rng.int(10_000_000, 89_999_999));
  const account = String(rng.int(0, 9_999_999_999)).padStart(10, "0");
  return ibanFor("DE", bank + account);
}

export function generate(seed: number, config: WorldConfig = loadWorldConfig()): World {
  const rng = new Rng(seed * 7919 + 13);
  const t = config.timeline;
  const f = config.fund;
  const start: string = t.start;
  const end = addDays(start, t.days);
  const funds: WorldFund[] = [];
  const usedNames = new Set<string>();
  let fundNo = 0;

  for (let ti = 1; ti <= t.tenants; ti++) {
    const tenant = `mgr${seed}x${ti}`;
    const nFunds = rng.int(t.funds_per_tenant[0], t.funds_per_tenant[1]);
    for (let fi = 1; fi <= nFunds; fi++) {
      fundNo += 1;
      const fr = rng.fork(fundNo);
      let base = fr.pick(FUND_NAMES);
      while (usedNames.has(base)) base = fr.pick(FUND_NAMES);
      usedNames.add(base);
      const name = `${base} ${["I", "II", "III", "IV"][fr.int(0, 3)]}`;
      const code = `${base.replace(/[^A-Z]/g, "").slice(0, 2)}${fundNo}`.toUpperCase();
      const terms = {
        eqRateBps: fr.pick(f.eq_rate_bps as number[]),
        prefBps: fr.pick(f.pref_bps as number[]),
        carryBps: fr.pick(f.carry_bps as number[]),
        noticeDays: 10,
        graceDays: 5,
        minTicket: f.ticket_euros[0] * 100,
        maxTicket: f.ticket_euros[1] * 100 * 2,
      };

      const investors: WorldInvestor[] = [];
      const newInvestor = (closing: number): WorldInvestor => {
        const n = investors.length + 1;
        const name = `${fr.pick(FIRST)} ${fr.pick(KIND)} ${n}`;
        const euros = Math.round(Math.exp(fr.next() * Math.log(f.ticket_euros[1] / f.ticket_euros[0])) * f.ticket_euros[0] / 1000) * 1000;
        const d = config.documents;
        const inv: WorldInvestor = {
          key: `${code}-L${String(n).padStart(3, "0")}`,
          name,
          email: `ops${n}@${name.split(" ")[0].toLowerCase()}-${code.toLowerCase()}.example`,
          iban: makeIban(fr),
          otherIban: makeIban(fr),
          admittedAt: closing,
          commitment: euros * 100,
          defaultsOn: fr.chance(config.behaviour.defaulter) ? fr.int(0, 2) : null,
          layout: fr.pick(["en_form", "en_form", "de_form", "letter"] as const),
          defects: {
            ocr: fr.chance(d.ocr_noise),
            wordsMissing: fr.chance(d.words_missing),
            wordsDisagree: fr.chance(d.words_disagree),
            badIban: fr.chance(d.bad_iban),
            misfiled: fr.chance(d.misfiled),
            missingEmail: fr.chance(d.missing_email),
          },
          seed: fr.int(1, 2 ** 30),
        };
        if (inv.layout === "letter") inv.defects.wordsMissing = false; // a letter always states the amount in words
        if (inv.defects.wordsMissing) inv.defects.wordsDisagree = false;
        investors.push(inv);
        return inv;
      };

      // Dates: every event on its own business day, in order.
      const taken = new Set<string>();
      const slot = (d: string): string => {
        let x = businessDay(d);
        while (taken.has(x)) x = businessDay(addDays(x, 1));
        taken.add(x);
        return x;
      };

      const closings: WorldClosing[] = [];
      const firstClose = slot(addDays(start, fr.int(0, 25)));
      const firstAdmitted = Array.from({ length: fr.int(f.investors_first_close[0], f.investors_first_close[1]) }, () => newInvestor(1).key);
      closings.push({ number: 1, date: firstClose, admitted: firstAdmitted, increases: [] });
      const nSub = fr.int(f.subsequent_closes[0], f.subsequent_closes[1]);
      let d = firstClose;
      for (let k = 2; k <= nSub + 1; k++) {
        d = addDays(d, fr.int(f.days_between_closes[0], f.days_between_closes[1]));
        const date = slot(d);
        const admitted = Array.from({ length: fr.int(f.investors_per_subsequent_close[0], f.investors_per_subsequent_close[1]) }, () => newInvestor(k).key);
        const increases = investors
          .filter((i) => i.admittedAt < k && fr.chance(f.increase_probability))
          .map((i) => ({ key: i.key, amount: Math.round((i.commitment * (0.1 + fr.next() * 0.6)) / 100_000) * 100_000 }))
          .filter((x) => x.amount > 0);
        closings.push({ number: k, date, admitted, increases });
      }

      const commitmentsAt = (date: string): number => {
        let total = 0;
        for (const c of closings) {
          if (c.date > date) continue;
          for (const k of c.admitted) total += investors.find((i) => i.key === k)!.commitment;
          for (const inc of c.increases) total += inc.amount;
        }
        return total;
      };

      const calls: WorldCall[] = [];
      let called = 0;
      let cd = addDays(firstClose, fr.int(5, 40));
      while (cd < end) {
        const date = slot(cd);
        if (date >= end) break;
        const total = commitmentsAt(date);
        const unfunded = total - called;
        const frac = f.call_fraction[0] + fr.next() * (f.call_fraction[1] - f.call_fraction[0]);
        // Calls are in round euros of a size a GP would ask for.
        const amount = Math.min(unfunded, Math.round((total * frac) / 100_000_00) * 100_000_00 + fr.int(0, 99) * 100);
        if (amount <= 0) break;
        calls.push({ number: calls.length + 1, date, amount, purpose: fr.pick(["investment", "investment", "investment", "management_fee", "fund_expenses"] as const) });
        called += amount;
        cd = addDays(cd, fr.int(f.days_between_calls[0], f.days_between_calls[1]));
      }

      const distributions: WorldDistribution[] = [];
      let dd = addDays(start, f.first_distribution_day + fr.int(0, 60));
      while (dd < end) {
        const date = slot(dd);
        if (date >= end) break;
        const calledSoFar = calls.filter((c) => c.date <= date).reduce((a, c) => a + c.amount, 0);
        if (calledSoFar > 0) {
          const frac = f.distribution_fraction[0] + fr.next() * (f.distribution_fraction[1] - f.distribution_fraction[0]);
          distributions.push({ number: distributions.length + 1, date, amount: Math.max(100, Math.round(calledSoFar * frac)) });
        }
        dd = addDays(dd, fr.int(f.days_between_distributions[0], f.days_between_distributions[1]));
      }

      funds.push({ tenant, key: `${tenant}/${code}`, code, name, accountIban: makeIban(fr), terms, investors, closings, calls, distributions });
    }
  }
  return { seed, start, end, funds, config };
}
