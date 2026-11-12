/**
 * Payment identifiers. Each capital call notice carries an ISO 11649 structured creditor
 * reference ("RF" + two check digits + up to 21 characters) so the bank statement line
 * can be tied back to exactly one investor's notice. Investor bank accounts are IBANs.
 * Both use the ISO 7064 mod-97 check.
 */

function mod97(s: string): number {
  let rem = 0;
  for (const ch of s) {
    const v = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of v) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem;
}

export function rfReference(body: string): string {
  const b = body.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (b.length === 0 || b.length > 21) throw new Error(`reference body must be 1-21 characters: ${body}`);
  const check = 98 - mod97(`${b}RF00`);
  return `RF${String(check).padStart(2, "0")}${b}`;
}

export function isValidRf(ref: string): boolean {
  const r = ref.toUpperCase().replace(/\s/g, "");
  if (!/^RF\d{2}[0-9A-Z]{1,21}$/.test(r)) return false;
  return mod97(`${r.slice(4)}${r.slice(0, 4)}`) === 1;
}

/**
 * Finds RF references in free text, for payers who paste one into the remittance line.
 * People write them in groups of four, so a reference may span several whitespace-separated
 * tokens; a candidate always ends at a token boundary and is never made by trimming
 * characters, because a trimmed typo can land on someone else's valid reference. If two
 * different readings starting at the same place are both valid, both are returned and the
 * caller treats the payment as ambiguous.
 */
export function findRfReferences(text: string): string[] {
  const tokens = text.toUpperCase().split(/[\s,;:/()]+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    if (!/^RF\d{2}/.test(tokens[i]) && !(tokens[i] === "RF" && /^\d{2}/.test(tokens[i + 1] ?? ""))) continue;
    let joined = "";
    for (let j = i; j < tokens.length && joined.length < 25; j++) {
      joined += tokens[j].replace(/[.]$/, "");
      if (isValidRf(joined)) out.add(joined);
      if (/[.]$/.test(tokens[j])) break;
    }
  }
  return [...out];
}

export function normaliseIban(iban: string): string {
  return iban.toUpperCase().replace(/[\s-]/g, "");
}

export function isValidIban(iban: string): boolean {
  const s = normaliseIban(iban);
  if (!/^[A-Z]{2}\d{2}[0-9A-Z]{11,30}$/.test(s)) return false;
  return mod97(`${s.slice(4)}${s.slice(0, 4)}`) === 1;
}

export function ibanFor(country: string, bban: string): string {
  const check = 98 - mod97(`${bban}${country}00`);
  return `${country}${String(check).padStart(2, "0")}${bban}`;
}
