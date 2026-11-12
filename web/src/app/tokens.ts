/**
 * Theme constants. Colours and sizes live here and in theme.css (as the same names);
 * components never carry their own numbers.
 */
export const color = {
  paper: "var(--paper)",
  surface: "var(--surface)",
  ink: "var(--ink)",
  muted: "var(--muted)",
  rule: "var(--rule)",
  ledger: "var(--ledger)",
  paid: "var(--paid)",
  owed: "var(--owed)",
  credit: "var(--credit)",
  unfunded: "var(--unfunded)",
  fault: "var(--fault)",
} as const;

export const motion = {
  /** The one orchestrated moment: capital-stack bars growing in on load. */
  stackGrow: 0.7,
  stackStagger: 0.018,
  expand: 0.22,
  ease: [0.2, 0.7, 0.2, 1] as const,
} as const;

export const layout = {
  stackRowsBeforeFold: 12,
  noticesPerInvestor: 6,
  reviewItemsShown: 8,
  ledgerRowsBeforeFold: 8,
  /** Timeline geometry in px: where the axis sits and how tall each kind of mark is. */
  timelineAxis: 46,
  closingMark: 40,
  eventMark: 22,
} as const;
