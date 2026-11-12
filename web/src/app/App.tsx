import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { CapitalStack } from "../features/capital-stack/CapitalStack";
import { EvaluationView } from "../features/evaluation/EvaluationView";
import { FundRail, type View } from "../features/funds/FundRail";
import { ReviewQueue } from "../features/review/ReviewQueue";
import { FundTimeline } from "../features/timeline/FundTimeline";
import { api, type Fund } from "../shared/api";
import { money, pct } from "../shared/format";
import { EmptyState, ErrorState, Skeleton } from "../shared/ui";

export function App() {
  const funds = useQuery({ queryKey: ["funds"], queryFn: api.funds });
  const [view, setView] = useState<View | null>(null);
  const current: View | null = view ?? (funds.data?.[0] ? { kind: "fund", id: funds.data[0].id } : null);
  const fund = current?.kind === "fund" ? funds.data?.find((f) => f.id === current.id) : undefined;

  return (
    <div className={fund && current?.kind === "fund" ? "shell" : "shell shell-wide"}>
      <FundRail funds={funds.data} loading={funds.isPending} view={current} onSelect={setView} />
      <main className="main">
        {funds.isPending ? (
          <>
            <Skeleton height="var(--s7)" width="60%" />
            <div style={{ height: "var(--s4)" }} />
            <Skeleton height="var(--s5)" width="80%" />
          </>
        ) : funds.isError ? (
          <ErrorState title="Your funds did not load" error={funds.error} onRetry={() => funds.refetch()} />
        ) : current?.kind === "evaluation" ? (
          <EvaluationView />
        ) : !fund ? (
          <EmptyState title="No funds yet">Create a fund with its LPA terms and account, then admit investors at a first closing.</EmptyState>
        ) : (
          <FundPage fund={fund} />
        )}
      </main>
      {fund && current?.kind === "fund" ? <ReviewQueue fund={fund} /> : null}
    </div>
  );
}

function FundPage({ fund }: { fund: Fund }) {
  return (
    <>
      <h2 className="hero-name">{fund.name}</h2>
      <p className="hero-sentence">
        <strong>{money(fund.committed)}</strong> committed by <strong>{fund.investors} investors</strong> over {fund.closings}{" "}
        {fund.closings === 1 ? "closing" : "closings"}. <strong>{pct(fund.called, fund.committed)}</strong> called in {fund.calls} calls,{" "}
        {fund.outstanding > 0 ? <span className="owed">{money(fund.outstanding)} of it not yet paid</span> : "all of it paid"}.{" "}
        {fund.distributions > 0 ? <>{money(fund.distributed)} distributed back.</> : null}
      </p>
      <CapitalStack fundId={fund.id} />
      <FundTimeline fundId={fund.id} />
    </>
  );
}
