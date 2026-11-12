import { Cents } from "../money/money";
import { isValidIban, normaliseIban } from "./identifiers";
import { wordsToEuros } from "./numberWords";

/**
 * Reads a subscription document (an investor's signed commitment) into the fields the
 * register needs. Code decides whether the reading is safe to use: every required field
 * present, the IBAN passes its check, the figures agree with the amount in words when the
 * form has both, the amount is inside the fund's ticket limits and the form names this
 * fund. Anything else goes to a person with the reasons attached.
 */

export interface SubscriptionFields {
  investorName: string | null;
  commitment: Cents | null;
  commitmentInWords: number | null;
  iban: string | null;
  email: string | null;
  fundName: string | null;
}

export interface Reading {
  fields: SubscriptionFields;
  problems: string[];
  decision: "accept" | "review";
}

export interface IntakeRules {
  fundName: string;
  minTicket: Cents;
  maxTicket: Cents;
}

const NAME_LABELS = ["name of subscriber", "subscriber", "investor name", "investor", "name des zeichners", "zeichner", "anleger"];
const AMOUNT_LABELS = ["capital commitment", "commitment amount", "commitment", "zeichnungsbetrag", "kapitalzusage", "zusage"];
const WORD_LABELS = ["in words", "in worten"];
const FUND_LABELS = ["fund", "fonds", "partnership"];

function labelled(lines: string[], labels: string[]): string | null {
  for (const line of lines) {
    const m = line.match(/^\s*([^:]{2,40}):\s*(.+)$/);
    if (!m) continue;
    const label = m[1].trim().toLowerCase();
    if (labels.some((l) => label === l || label.endsWith(` ${l}`) || label.startsWith(`${l} `))) return m[2].trim();
  }
  return null;
}

/** "EUR 1.250.000,00", "€1,250,000", "1 250 000,00 EUR"; OCR's O-for-0 and l-for-1 inside figures are undone. */
export function parseMoney(raw: string): Cents | null {
  const m = raw.match(/(?:EUR|€)\s*([0-9OolI][0-9OolI.,\s']*[0-9OolI])|([0-9OolI][0-9OolI.,\s']*[0-9OolI])\s*(?:EUR|€|Euro)/i);
  if (!m) return null;
  const s = (m[1] ?? m[2]).replace(/[Oo]/g, "0").replace(/[lI]/g, "1").replace(/\s|'/g, "");
  if (!/^[0-9.,]+$/.test(s)) return null;
  const last = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  let whole = s;
  let frac = "00";
  if (last >= 0 && s.length - last - 1 === 2) {
    whole = s.slice(0, last);
    frac = s.slice(last + 1);
  }
  const groups = whole.split(/[.,]/);
  if (groups.length > 1 && groups.slice(1).some((g) => g.length !== 3)) return null;
  const digits = groups.join("");
  if (!/^\d+$/.test(digits) || digits.length > 13) return null;
  return Number(digits) * 100 + Number(frac);
}

export function readSubscription(text: string, rules: IntakeRules): Reading {
  const flat = text.replace(/\r/g, "");
  const lines = flat.split("\n");
  const letter = flat.match(/We,\s+(.+?),\s+hereby irrevocably commit\s+(.+?)\s+\((.+?)\)\s+to\s+(.+?)\./s);

  let investorName = labelled(lines, NAME_LABELS);
  let amountRaw = labelled(lines, AMOUNT_LABELS);
  let words = labelled(lines, WORD_LABELS);
  let fundName = labelled(lines, FUND_LABELS);
  if (letter) {
    investorName ??= letter[1].replace(/\s+/g, " ").trim();
    amountRaw ??= letter[2];
    words ??= letter[3];
    fundName ??= letter[4].replace(/\s+/g, " ").trim();
  }
  if (amountRaw && !words) {
    const paren = amountRaw.match(/\(([^)]+)\)/);
    if (paren) words = paren[1];
  }
  const ibanMatch = flat.match(/IBAN[:\s]*([A-Z]{2}[0-9]{2}(?:[ ]?[0-9A-Z]){11,30})/);
  const emailMatch = flat.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);

  const fields: SubscriptionFields = {
    investorName: investorName ? investorName.replace(/\s+/g, " ") : null,
    commitment: amountRaw ? parseMoney(amountRaw) : null,
    commitmentInWords: words ? wordsToEuros(words.replace(/euros?|eur\b/gi, "")) : null,
    iban: ibanMatch ? normaliseIban(ibanMatch[1]) : null,
    email: emailMatch ? emailMatch[0].toLowerCase() : null,
    fundName: fundName ? fundName.replace(/\s+/g, " ") : null,
  };

  const problems: string[] = [];
  if (!fields.investorName) problems.push("investor name not found");
  if (fields.commitment === null) problems.push("commitment amount not readable");
  if (!fields.iban) problems.push("IBAN not found");
  else if (!isValidIban(fields.iban)) problems.push("IBAN fails its check digits");
  if (!fields.email) problems.push("notice e-mail not found");
  if (words && fields.commitmentInWords === null) problems.push("amount in words not readable");
  if (fields.commitment !== null && fields.commitmentInWords !== null && fields.commitment !== fields.commitmentInWords * 100) {
    problems.push("figures and words disagree");
  }
  if (fields.commitment !== null && (fields.commitment < rules.minTicket || fields.commitment > rules.maxTicket)) {
    problems.push("commitment outside the fund's ticket limits");
  }
  if (fields.fundName && normaliseName(fields.fundName) !== normaliseName(rules.fundName)) {
    problems.push(`form is for "${fields.fundName}"`);
  }
  return { fields, problems, decision: problems.length ? "review" : "accept" };
}

function normaliseName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
