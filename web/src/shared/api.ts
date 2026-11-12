/**
 * Data comes from the running service when VITE_API_URL is set (with a bearer token in
 * VITE_API_TOKEN), and otherwise from the demo export in public/demo, which is the same
 * API's responses written to files by scripts/export-demo.ts.
 */
const API = import.meta.env.VITE_API_URL as string | undefined;
const TOKEN = import.meta.env.VITE_API_TOKEN as string | undefined;

export class LoadError extends Error {}

async function get<T>(apiPath: string, demoPath: string): Promise<T> {
  const url = API ? `${API}${apiPath}` : `${import.meta.env.BASE_URL}demo/${demoPath}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: API && TOKEN ? { authorization: `Bearer ${TOKEN}` } : {} });
  } catch {
    throw new LoadError("The service could not be reached.");
  }
  if (!res.ok) throw new LoadError(`The service answered ${res.status}.`);
  return (await res.json()) as T;
}

export interface Fund {
  id: string; code: string; name: string; currency: string; investors: number; closings: number;
  committed: number; called: number; calls: number; distributed: number; distributions: number;
  outstanding: number; openNotices: number; defaultedNotices: number; lastEventDate: string | null;
  review: { payments: number; documents: number };
  outbox: { pending: number; failed: number; confirmed: number };
  terms: { eqRateBps: number; prefBps: number; carryBps: number; graceDays: number };
}

export interface CapitalAccount {
  investorId: string; number: number; name: string; commitment: number; called: number; unfunded: number;
  catchUp: number; rebalancingCredit: number; interestPaid: number; interestReceived: number; creditBalance: number;
  due: number; paid: number; outstanding: number; distributed: number; defaulted: boolean;
}

export interface Notice {
  id: string; investorId: string; kind: string; reference: string | null; gross: number; interest: number;
  creditApplied: number; amountDue: number; paid: number; dueDate: string | null; status: string; issuedOn: string; delivery: string | null;
}

export type TimelineEvent =
  | { type: "closing"; number: number; date: string; amount: number; catchUp: number; interest: number }
  | { type: "call"; number: number; date: string; amount: number; purpose: string; dueDate: string }
  | { type: "distribution"; number: number; date: string; amount: number; toInvestors: number; toGp: number };

export interface Equalisation {
  number: number; date: string; interestToFund: number;
  investors: { investorId: string; number: number; name: string; calls: number; catchUp: number; rebalancing: number; interestPaid: number; interestReceived: number }[];
}

export interface ReviewEntry {
  id: number; entry_ref: string; amount: number; unapplied: number; booking_date: string; debtor_name: string | null;
  debtor_iban: string | null; structured_ref: string | null; unstructured: string | null; review_reason: string;
}

export interface ReviewDocument { id: string; problems: string[]; fields: { investorName: string | null } }

export const api = {
  funds: () => get<Fund[]>("/v1/funds", "funds.json"),
  accounts: (id: string) => get<CapitalAccount[]>(`/v1/funds/${id}/capital-accounts`, `funds/${id}/accounts.json`),
  notices: (id: string) => get<Notice[]>(`/v1/funds/${id}/notices`, `funds/${id}/notices.json`),
  timeline: (id: string) => get<TimelineEvent[]>(`/v1/funds/${id}/timeline`, `funds/${id}/timeline.json`),
  equalisation: (id: string, n: number) => get<Equalisation>(`/v1/funds/${id}/closings/${n}/equalisation`, `funds/${id}/closings/${n}.json`),
  reviewPayments: (id: string) => get<ReviewEntry[]>(`/v1/funds/${id}/review/payments`, `funds/${id}/review.json`),
  reviewDocuments: (id: string) => get<ReviewDocument[]>(`/v1/funds/${id}/documents?status=review`, `funds/${id}/documents.json`),
  report: () => get<Record<string, any>>("/report.json", "report.json"),
};
