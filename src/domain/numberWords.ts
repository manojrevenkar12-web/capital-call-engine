/** Amounts written out in English or German words, as subscription forms state them next to the figures. */

const EN: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};
const DE: Record<string, number> = {
  null: 0, eins: 1, ein: 1, eine: 1, zwei: 2, drei: 3, vier: 4, fuenf: 5, sechs: 6, sieben: 7, acht: 8,
  neun: 9, zehn: 10, elf: 11, zwoelf: 12, dreizehn: 13, vierzehn: 14, fuenfzehn: 15, sechzehn: 16,
  siebzehn: 17, achtzehn: 18, neunzehn: 19, zwanzig: 20, dreissig: 30, vierzig: 40, fuenfzig: 50,
  sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90,
};
const SCALE: Record<string, number> = {
  hundred: 100, thousand: 1_000, million: 1_000_000, millions: 1_000_000, billion: 1_000_000_000,
  hundert: 100, tausend: 1_000, millionen: 1_000_000, milliarde: 1_000_000_000, milliarden: 1_000_000_000,
};
const FILLER = new Set(["and", "und", "euro", "euros", "eur", "only"]);

function evaluate(tokens: string[], units: Record<string, number>): number | null {
  let total = 0;
  let current = 0;
  let seen = false;
  for (const t of tokens) {
    if (FILLER.has(t)) continue;
    if (t in units) {
      current += units[t];
      seen = true;
    } else if (t in SCALE) {
      const s = SCALE[t];
      seen = true;
      if (s === 100) current = (current || 1) * 100;
      else {
        total += (current || 1) * s;
        current = 0;
      }
    } else return null;
  }
  return seen ? total + current : null;
}

/** German writes the number as one word; split it greedily into known parts. */
function splitGerman(word: string): string[] | null {
  const vocab = [...Object.keys(DE), ...Object.keys(SCALE), "und", "euro"].sort((a, b) => b.length - a.length);
  const out: string[] = [];
  let i = 0;
  while (i < word.length) {
    const hit = vocab.find((v) => word.startsWith(v, i));
    if (!hit) return null;
    out.push(hit);
    i += hit.length;
  }
  return out;
}

/** Whole euros written in words, or null when the text is not a number we can read. */
export function wordsToEuros(text: string): number | null {
  const t = text
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[(),.]/g, " ")
    .replace(/-/g, " ")
    .trim();
  if (!t) return null;
  const en = evaluate(t.split(/\s+/), EN);
  if (en !== null) return en;
  const parts: string[] = [];
  for (const w of t.split(/\s+/)) {
    const s = splitGerman(w);
    if (!s) return null;
    parts.push(...s);
  }
  return evaluate(parts, DE);
}

const EN_UNITS = Object.entries(EN).reduce<Record<number, string>>((a, [k, v]) => ((a[v] = k), a), {});

function enBelowThousand(n: number): string {
  const parts: string[] = [];
  if (n >= 100) {
    parts.push(`${EN_UNITS[Math.floor(n / 100)]} hundred`);
    n %= 100;
    if (n) parts.push("and");
  }
  if (n >= 20) {
    parts.push(EN_UNITS[n - (n % 10)] + (n % 10 ? `-${EN_UNITS[n % 10]}` : ""));
  } else if (n > 0) parts.push(EN_UNITS[n]);
  return parts.join(" ");
}

/** Used by the simulator to write forms; kept here so reading and writing agree on spelling. */
export function eurosToEnglish(n: number): string {
  if (n === 0) return "zero";
  const out: string[] = [];
  for (const [s, name] of [[1_000_000_000, "billion"], [1_000_000, "million"], [1_000, "thousand"]] as const) {
    if (n >= s) {
      out.push(`${enBelowThousand(Math.floor(n / s))} ${name}`);
      n %= s;
    }
  }
  if (n) out.push(enBelowThousand(n));
  return out.join(" ");
}

const DE_UNITS: Record<number, string> = {
  1: "ein", 2: "zwei", 3: "drei", 4: "vier", 5: "fünf", 6: "sechs", 7: "sieben", 8: "acht", 9: "neun",
  10: "zehn", 11: "elf", 12: "zwölf", 13: "dreizehn", 14: "vierzehn", 15: "fünfzehn", 16: "sechzehn",
  17: "siebzehn", 18: "achtzehn", 19: "neunzehn",
};
const DE_TENS: Record<number, string> = {
  20: "zwanzig", 30: "dreißig", 40: "vierzig", 50: "fünfzig", 60: "sechzig", 70: "siebzig", 80: "achtzig", 90: "neunzig",
};

function deBelowThousand(n: number): string {
  let s = "";
  if (n >= 100) {
    s += `${DE_UNITS[Math.floor(n / 100)]}hundert`;
    n %= 100;
  }
  if (n >= 20) s += (n % 10 ? `${DE_UNITS[n % 10]}und` : "") + DE_TENS[n - (n % 10)];
  else if (n === 1) s += "eins";
  else if (n > 0) s += DE_UNITS[n];
  return s;
}

export function eurosToGerman(n: number): string {
  const out: string[] = [];
  const m = Math.floor(n / 1_000_000);
  if (m) out.push(m === 1 ? "eine Million" : `${deBelowThousand(m)} Millionen`);
  n %= 1_000_000;
  const rest = (Math.floor(n / 1000) ? `${deBelowThousand(Math.floor(n / 1000)).replace(/eins$/, "ein")}tausend` : "") + deBelowThousand(n % 1000);
  if (rest) out.push(rest);
  return out.join(" ") || "null";
}
