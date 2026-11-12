const eur = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const eurCents = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", minimumFractionDigits: 2 });

export const money = (cents: number) => eur.format(Math.round(cents / 100));
export const exact = (cents: number) => eurCents.format(cents / 100);

export function short(cents: number): string {
  const e = cents / 100;
  if (Math.abs(e) >= 1e6) return `€${(e / 1e6).toFixed(1)}m`;
  if (Math.abs(e) >= 1e3) return `€${Math.round(e / 1e3)}k`;
  return `€${Math.round(e)}`;
}

export const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "0%");

export function date(d: string): string {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
