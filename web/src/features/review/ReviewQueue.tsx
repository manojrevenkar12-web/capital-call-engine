import { useQuery } from "@tanstack/react-query";
import { layout } from "../../app/tokens";
import { api, type Fund } from "../../shared/api";
import { date, exact } from "../../shared/format";
import { ErrorState, SkeletonRows } from "../../shared/ui";

/** What code would not decide on its own, waiting for someone in fund operations. */
export function ReviewQueue({ fund }: { fund: Fund }) {
  const payments = useQuery({ queryKey: ["review-payments", fund.id], queryFn: () => api.reviewPayments(fund.id) });
  const documents = useQuery({ queryKey: ["review-documents", fund.id], queryFn: () => api.reviewDocuments(fund.id) });
  const waiting = (payments.data?.length ?? 0) + (documents.data?.length ?? 0) + fund.outbox.failed;

  return (
    <aside className="aside queue" aria-labelledby="queue-title">
      <h2 id="queue-title">Waiting for a person</h2>
      <p>
        {payments.isPending || documents.isPending
          ? "Checking the queues."
          : waiting === 0
            ? "Nothing. Every payment, document and e-mail was settled by the rules."
            : `${waiting} ${waiting === 1 ? "item" : "items"} the rules would not settle alone.`}
      </p>

      <div className="queue-group">
        <h3><span>Bank credits</span><span>{payments.data?.length ?? ""}</span></h3>
        {payments.isPending ? (
          <SkeletonRows rows={3} height="var(--s7)" />
        ) : payments.isError ? (
          <ErrorState title="The payment queue did not load" error={payments.error} onRetry={() => payments.refetch()} />
        ) : payments.data.length === 0 ? (
          <div className="queue-item"><span>Every credit on the account is tied to a notice.</span></div>
        ) : (
          payments.data.slice(0, layout.reviewItemsShown).map((e) => (
            <div className="queue-item" key={e.id}>
              <b>{exact(e.unapplied)}</b> from {e.debtor_name ?? "an unnamed payer"} on {date(e.booking_date)}
              <span>{e.review_reason}{e.unstructured ? `: "${e.unstructured}"` : ""}</span>
            </div>
          ))
        )}
      </div>

      <div className="queue-group">
        <h3><span>Subscription documents</span><span>{documents.data?.length ?? ""}</span></h3>
        {documents.isPending ? (
          <SkeletonRows rows={2} height="var(--s6)" />
        ) : documents.isError ? (
          <ErrorState title="The document queue did not load" error={documents.error} onRetry={() => documents.refetch()} />
        ) : documents.data.length === 0 ? (
          <div className="queue-item"><span>No forms waiting. Unclear forms stop here before anyone is admitted.</span></div>
        ) : (
          documents.data.map((d) => (
            <div className="queue-item" key={d.id}>
              <b>{d.fields.investorName ?? "Unnamed investor"}</b>
              <span>{d.problems.join("; ")}</span>
            </div>
          ))
        )}
      </div>

      <div className="queue-group">
        <h3><span>Notices in default</span><span>{fund.defaultedNotices}</span></h3>
        <div className="queue-item">
          <span>
            {fund.defaultedNotices === 0
              ? "No investor is past the due date plus the grace period."
              : `Unpaid more than ${fund.terms.graceDays} days after the due date. Each investor has had one notice of default.`}
          </span>
        </div>
      </div>

      <div className="queue-group">
        <h3><span>E-mails the provider refused</span><span>{fund.outbox.failed}</span></h3>
        <div className="queue-item">
          <span>{fund.outbox.confirmed} notices confirmed delivered, {fund.outbox.pending} still being sent.</span>
        </div>
      </div>
    </aside>
  );
}
