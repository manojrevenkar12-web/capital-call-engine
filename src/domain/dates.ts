/** Calendar dates as YYYY-MM-DD strings, counted in UTC so time zones never move a day. */

export type IsoDate = string;

const DAY = 86_400_000;

function ms(d: IsoDate): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`not a date: ${d}`);
  return Date.parse(`${d}T00:00:00Z`);
}

export function days(from: IsoDate, to: IsoDate): number {
  return Math.round((ms(to) - ms(from)) / DAY);
}

export function addDays(d: IsoDate, n: number): IsoDate {
  return new Date(ms(d) + n * DAY).toISOString().slice(0, 10);
}

export function isWeekend(d: IsoDate): boolean {
  const wd = new Date(ms(d)).getUTCDay();
  return wd === 0 || wd === 6;
}

export function addBusinessDays(d: IsoDate, n: number): IsoDate {
  let out = d;
  let left = n;
  while (left > 0) {
    out = addDays(out, 1);
    if (!isWeekend(out)) left -= 1;
  }
  return out;
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a > b ? a : b;
}
