import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api";
import { exact } from "../../shared/format";
import { ErrorState, SectionHead, SkeletonRows } from "../../shared/ui";

type R = Record<string, any>;

const CHECKS: { label: string; get: (t: R) => [number, number]; zeroIsGood?: boolean; rate?: boolean }[] = [
  { label: "Commitments read from subscription documents", get: (t) => [t.commitments.right, t.commitments.checked] },
  { label: "Forms that needed a person sent to one", get: (t) => [t.documents.caught, t.documents.neededReview] },
  { label: "Forms accepted with a wrong field", get: (t) => [t.documents.acceptedWrong, t.documents.accepted], zeroIsGood: true },
  { label: "Investor shares of every call, after all closings", get: (t) => [t.shares.right, t.shares.checked] },
  { label: "Equalisation per investor per closing (catch-up, credit, interest)", get: (t) => [t.equalisation.right, t.equalisation.checked] },
  { label: "Notices with the right share, credit and amount due", get: (t) => [t.notices.right, t.notices.expected] },
  { label: "Notices delivered exactly once", get: (t) => [t.delivery.exactlyOnce, t.delivery.notices] },
  { label: "Investor payments settled by the rules, the rest by a person", get: (t) => [t.payments.autoRight, t.payments.investorEntries], rate: true },
  { label: "Payments tied to the wrong notice", get: (t) => [t.payments.autoWrong, t.payments.investorEntries], zeroIsGood: true },
  { label: "Defaults declared that should have been", get: (t) => [t.defaults.flagged, t.defaults.truth] },
  { label: "Defaults declared that should not have been", get: (t) => [t.defaults.falseFlags, t.defaults.truth], zeroIsGood: true },
  { label: "Distribution waterfalls tier by tier", get: (t) => [t.waterfall.tiersRight, t.waterfall.distributions] },
  { label: "Investor shares of distributions", get: (t) => [t.waterfall.sharesRight, t.waterfall.sharesChecked] },
  { label: "Duplicate requests that created a second event", get: (t) => [t.idempotency.extraEvents, t.idempotency.duplicateRequests], zeroIsGood: true },
  { label: "Requests for another manager's fund refused", get: (t) => [t.tenancy.probesRefused, t.tenancy.probes] },
];

function cell(t: R | undefined, c: (typeof CHECKS)[number]) {
  if (!t) return <td className="num">not run yet</td>;
  const [a, b] = c.get(t);
  const ok = c.zeroIsGood ? a === 0 : a === b;
  return <td className={`num ${c.rate ? "" : ok ? "ok" : "bad"}`}>{c.zeroIsGood ? `${a}` : `${a} of ${b}`}</td>;
}

export function EvaluationView() {
  const q = useQuery({ queryKey: ["report"], queryFn: api.report });
  return (
    <>
      <h2 className="hero-name">Checked against the answer key</h2>
      <p className="hero-sentence">
        A simulated world runs fund managers, investors, a bank and an e-mail provider against the real service. It keeps its own
        answer key, worked out separately, and the service never sees it. Held-out worlds were run once, after the code was frozen.
      </p>
      {q.isPending ? (
        <SkeletonRows rows={10} />
      ) : q.isError ? (
        <ErrorState title="The evaluation report did not load" error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <section>
            <SectionHead title="Results" note={`${q.data.dev.total.funds} development funds, ${q.data.heldout ? q.data.heldout.total.funds : 0} held-out funds`} />
            <table className="eval-table">
              <thead><tr><th>Check</th><th className="num">Development worlds</th><th className="num">Held-out worlds</th></tr></thead>
              <tbody>
                {CHECKS.map((c) => (
                  <tr key={c.label}><td>{c.label}</td>{cell(q.data.dev.total, c)}{cell(q.data.heldout?.total, c)}</tr>
                ))}
                <tr>
                  <td>Cash on the account not accounted for</td>
                  <td className="num ok">{exact(q.data.dev.total.cash.unaccounted)}</td>
                  <td className={`num ${q.data.heldout ? "ok" : ""}`}>{q.data.heldout ? exact(q.data.heldout.total.cash.unaccounted) : "not run yet"}</td>
                </tr>
              </tbody>
            </table>
          </section>
          <section>
            <SectionHead title="Switch one safeguard off" note="Same development worlds, one change each" />
            <table className="eval-table">
              <thead><tr><th>Safeguard switched off</th><th>What happens</th></tr></thead>
              <tbody>
                <tr>
                  <td>Falling back to the payer's known account when the reference is missing</td>
                  <td>{q.data.dev.ablations.no_iban_fallback.payments.toReview} payments wait for a person instead of {q.data.dev.total.payments.toReview}</td>
                </tr>
                <tr>
                  <td>Asking the provider before resending after a timeout or crash</td>
                  <td>{q.data.dev.ablations.blind_retry.delivery.twiceOrMore} notices reach the investor twice instead of {q.data.dev.total.delivery.twiceOrMore}</td>
                </tr>
              </tbody>
            </table>
            <p className="eval-note">
              The world is simulated; the formats are real (camt.053.001.08 statements, ISO 11649 references, IBAN check digits).
            </p>
          </section>
        </>
      )}
    </>
  );
}
