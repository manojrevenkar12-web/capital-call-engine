import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { segments } from "../features/capital-stack/CapitalStack";

const fund = {
  id: "f1", code: "HP1", name: "Hafen Partners I", currency: "EUR", investors: 2, closings: 2, committed: 10_000_000_00,
  called: 4_000_000_00, calls: 3, distributed: 0, distributions: 0, outstanding: 50_000_00, openNotices: 1, defaultedNotices: 0,
  lastEventDate: "2025-06-02", review: { payments: 0, documents: 0 }, outbox: { pending: 0, failed: 0, confirmed: 9 },
  terms: { eqRateBps: 800, prefBps: 800, carryBps: 2000, graceDays: 5 },
};
const accounts = [
  { investorId: "a", number: 1, name: "Elbe Family Office GmbH", commitment: 7_000_000_00, called: 2_800_000_00, unfunded: 4_200_000_00, catchUp: 0, rebalancingCredit: 1_200_000_00, interestPaid: 0, interestReceived: 12_000_00, creditBalance: 0, due: 1_600_000_00, paid: 1_550_000_00, outstanding: 50_000_00, distributed: 0, defaulted: false },
  { investorId: "b", number: 2, name: "Havel Pension Trust", commitment: 3_000_000_00, called: 1_200_000_00, unfunded: 1_800_000_00, catchUp: 1_200_000_00, rebalancingCredit: 0, interestPaid: 12_000_00, interestReceived: 0, creditBalance: 0, due: 1_212_000_00, paid: 1_212_000_00, outstanding: 0, distributed: 0, defaulted: false },
];

function respond(routes: Record<string, unknown>, fail = new Set<string>()) {
  return vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    if (!key || fail.has(key)) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  });
}

const routes = {
  "funds.json": [fund],
  "accounts.json": accounts,
  "timeline.json": [{ type: "closing", number: 1, date: "2025-01-06", amount: 0, catchUp: 0, interest: 0 }, { type: "closing", number: 2, date: "2025-04-01", amount: 0, catchUp: 0, interest: 0 }],
  "closings/2.json": { number: 2, date: "2025-04-01", interestToFund: 0, investors: [] },
  "review.json": [],
  "documents.json": [],
  "notices.json": [],
};

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("dashboard", () => {
  it("shows the fund's position as a sentence and its investors' capital stack", async () => {
    vi.stubGlobal("fetch", respond(routes));
    mount();
    expect(await screen.findByRole("heading", { name: "Hafen Partners I" })).toBeTruthy();
    expect(screen.getByText(/40%/)).toBeTruthy();
    expect(await screen.findByText("Elbe Family Office GmbH")).toBeTruthy();
    expect(await screen.findByText(/Nothing\. Every payment/)).toBeTruthy();
  });

  it("opens an investor's capital account when their row is chosen", async () => {
    vi.stubGlobal("fetch", respond(routes));
    mount();
    fireEvent.click(await screen.findByText("Havel Pension Trust"));
    expect(await screen.findByText("Catch-up at later closings")).toBeTruthy();
    expect(await screen.findByText("No notices yet")).toBeTruthy();
  });

  it("offers a retry when the funds do not load, and recovers", async () => {
    const fetcher = respond(routes, new Set(["funds.json"]));
    vi.stubGlobal("fetch", fetcher);
    mount();
    expect(await screen.findByText("Your funds did not load")).toBeTruthy();
    vi.stubGlobal("fetch", respond(routes));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Hafen Partners I" })).toBeTruthy());
  });

  it("says what to do when the manager has no funds", async () => {
    vi.stubGlobal("fetch", respond({ ...routes, "funds.json": [] }));
    mount();
    expect(await screen.findByText("No funds yet")).toBeTruthy();
  });
});

describe("capital stack segments", () => {
  it("splits the commitment into settled, owed and not yet called", () => {
    const s = segments(accounts[0]);
    expect(s.settled + s.owed + s.unfunded).toBeCloseTo(1);
    expect(s.owed).toBeCloseTo(0.005);
    expect(s.unfunded).toBeCloseTo(0.6);
  });
});
