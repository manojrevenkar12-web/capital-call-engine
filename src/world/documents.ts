import { eurosToEnglish, eurosToGerman } from "../domain/numberWords";
import { Rng } from "./rng";
import { WorldFund, WorldInvestor } from "./world";

/**
 * Renders an investor's subscription document as the text an e-signature export or OCR
 * would give, with the defects the world assigned. Returns the text and what a careful
 * person reading it would conclude.
 */

export interface RenderedDocument {
  text: string;
  /** Whether a careful reader would have to stop and check. */
  needsReview: boolean;
  reasons: string[];
}

function enMoney(cents: number): string {
  return `EUR ${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function deMoney(cents: number): string {
  return `${(cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`;
}

function spacedIban(iban: string): string {
  return iban.replace(/(.{4})/g, "$1 ").trim();
}

/** OCR misreads 0 as O and 1 as l inside figures, and splits IBAN groups oddly. Nothing it does loses a digit. */
function ocr(text: string, rng: Rng): string {
  return text.replace(/\d/g, (ch) => {
    if (ch === "0" && rng.chance(0.15)) return "O";
    if (ch === "1" && rng.chance(0.1)) return "l";
    return ch;
  });
}

function typo(iban: string, rng: Rng): string {
  const i = rng.int(6, iban.length - 1);
  const d = String((Number(iban[i]) + rng.int(1, 8)) % 10);
  return iban.slice(0, i) + d + iban.slice(i + 1);
}

export function renderSubscription(fund: WorldFund, inv: WorldInvestor, otherFundName: string): RenderedDocument {
  const rng = new Rng(inv.seed);
  const x = inv.defects;
  const euros = inv.commitment / 100;
  const wordsAmount = x.wordsDisagree ? euros + rng.pick([-100_000, 100_000, 50_000, -50_000].filter((v) => euros + v > 0)) : euros;
  const iban = x.badIban ? typo(inv.iban, rng) : inv.iban;
  const fundName = x.misfiled ? otherFundName : fund.name;
  const reasons: string[] = [];
  if (x.wordsDisagree) reasons.push("words disagree");
  if (x.badIban) reasons.push("IBAN typo");
  if (x.misfiled) reasons.push("names another fund");
  if (x.missingEmail) reasons.push("no e-mail");

  let text: string;
  if (inv.layout === "en_form") {
    const figure = ocrIf(enMoney(inv.commitment), x.ocr, rng);
    text = [
      "SUBSCRIPTION AGREEMENT — SIGNATURE PAGE",
      `Fund: ${fundName}`,
      `Name of Subscriber: ${inv.name}`,
      `Capital Commitment: ${figure}`,
      ...(x.wordsMissing ? [] : [`In words: ${eurosToEnglish(wordsAmount)} euros`]),
      `Bank account for distributions:`,
      `IBAN: ${x.ocr ? spacedIban(iban) : iban}`,
      ...(x.missingEmail ? [] : [`E-mail for notices: ${inv.email}`]),
      `Signed: ____________________   Date: ${rng.int(1, 28)}.${rng.int(1, 12)}.2023`,
    ].join("\n");
  } else if (inv.layout === "de_form") {
    const figure = ocrIf(deMoney(inv.commitment), x.ocr, rng);
    text = [
      "ZEICHNUNGSSCHEIN",
      `Fonds: ${fundName}`,
      `Name des Zeichners: ${inv.name}`,
      `Zeichnungsbetrag: ${figure}`,
      ...(x.wordsMissing ? [] : [`In Worten: ${eurosToGerman(wordsAmount)} Euro`]),
      `IBAN: ${spacedIban(iban)}`,
      ...(x.missingEmail ? [] : [`E-Mail: ${inv.email}`]),
      "Unterschrift: ____________________",
    ].join("\n");
  } else {
    const figure = ocrIf(enMoney(inv.commitment), x.ocr, rng);
    text = [
      "Dear Sirs,",
      `We, ${inv.name}, hereby irrevocably commit ${figure} (${eurosToEnglish(wordsAmount)} euros) to ${fundName}.`,
      `Our account: IBAN ${spacedIban(iban)}`,
      ...(x.missingEmail ? [] : [`Please send all notices to ${inv.email}`]),
      "Yours faithfully,",
    ].join("\n");
  }
  return { text, needsReview: reasons.length > 0, reasons };
}

function ocrIf(s: string, on: boolean, rng: Rng): string {
  return on ? ocr(s, rng) : s;
}
