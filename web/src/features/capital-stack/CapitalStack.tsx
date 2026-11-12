import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useMemo, useState } from "react";
import { color, layout, motion as m } from "../../app/tokens";
import { api, type CapitalAccount, type Notice } from "../../shared/api";
import { date, exact, money } from "../../shared/format";
import { EmptyState, ErrorState, SectionHead, SkeletonRows } from "../../shared/ui";

type Sort = "number" | "commitment" | "outstanding";

export function segments(a: CapitalAccount) {
  const owed = Math.max(0, Math.min(a.outstanding, a.called));
  const settled = Math.max(0, a.called - owed);
  const unfunded = Math.max(0, a.commitment - a.called);
  const total = settled + owed + unfunded || 1;
  return { settled: settled / total, owed: owed / total, unfunded: unfunded / total };
}

export function CapitalStack({ fundId }: { fundId: string }) {
  const accounts = useQuery({ queryKey: ["accounts", fundId], queryFn: () => api.accounts(fundId) });
  const [sort, setSort] = useState<Sort>("number");
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  const rows = useMemo(() => {
    const list = [...(accounts.data ?? [])];
    if (sort === "commitment") list.sort((a, b) => b.commitment - a.commitment);
    if (sort === "outstanding") list.sort((a, b) => b.outstanding - a.outstanding || Number(b.defaulted) - Number(a.defaulted));
    return list;
  }, [accounts.data, sort]);
  const largest = Math.max(1, ...rows.map((r) => r.commitment));
  const shown = all ? rows : rows.slice(0, layout.stackRowsBeforeFold);

  return (
    <section aria-labelledby="stack-title">
      <SectionHead
        title="Capital stack"
        note={
          <span id="stack-title">
            Sort by{" "}
            {(["number", "commitment", "outstanding"] as const).map((s, i) => (
              <span key={s}>
                {i > 0 ? ", " : ""}
                <button className="link-button" style={{ margin: 0 }} aria-pressed={sort === s} onClick={() => setSort(s)}>
                  {s === "number" ? "investor number" : s === "commitment" ? "commitment" : "what is owed"}
                </button>
              </span>
            ))}
          </span>
        }
      />
      <div className="legend">
        <span><i className="swatch" style={{ background: color.paid }} />Called and settled</span>
        <span><i className="swatch" style={{ background: color.owed }} />Called, not yet paid</span>
        <span><i className="swatch" style={{ background: color.unfunded }} />Not yet called</span>
        <span>Bar length is the commitment, against the largest in the fund</span>
      </div>
      {accounts.isPending ? (
        <SkeletonRows rows={8} />
      ) : accounts.isError ? (
        <ErrorState title="Capital accounts did not load" error={accounts.error} onRetry={() => accounts.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No investors yet">Investors appear here once their subscription documents are accepted at a closing.</EmptyState>
      ) : (
        <div>
          {shown.map((a, i) => (
            <StackRow key={a.investorId} a={a} index={i} scale={a.commitment / largest} fundId={fundId} open={open === a.investorId} onToggle={() => setOpen(open === a.investorId ? null : a.investorId)} />
          ))}
          {rows.length > layout.stackRowsBeforeFold ? (
            <button className="link-button" onClick={() => setAll(!all)}>
              {all ? "Show fewer investors" : `Show all ${rows.length} investors`}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

function StackRow({ a, index, scale, fundId, open, onToggle }: { a: CapitalAccount; index: number; scale: number; fundId: string; open: boolean; onToggle: () => void }) {
  const reduce = useReducedMotion();
  const s = segments(a);
  return (
    <>
      <button className="stack-row" aria-expanded={open} onClick={onToggle}>
        <span className="stack-name">
          <small>{a.number}</small>
          {a.name}
        </span>
        <motion.span
          className="stack-bar"
          initial={reduce ? false : { width: 0 }}
          animate={{ width: `${Math.max(scale * 100, 2)}%` }}
          transition={{ duration: m.stackGrow, delay: index * m.stackStagger, ease: m.ease }}
          aria-label={`${money(a.called)} called of ${money(a.commitment)}, ${money(a.outstanding)} not yet paid`}
        >
          <i style={{ width: `${s.settled * 100}%`, background: color.paid }} />
          <i style={{ width: `${s.owed * 100}%`, background: color.owed }} />
        </motion.span>
        <span className="stack-figure">
          {money(a.commitment)}
          {a.defaulted ? <span className="fault">in default</span> : null}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            className="stack-detail"
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: m.expand, ease: m.ease }}
          >
            <InvestorDetail a={a} fundId={fundId} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

function InvestorDetail({ a, fundId }: { a: CapitalAccount; fundId: string }) {
  const notices = useQuery({ queryKey: ["notices", fundId], queryFn: () => api.notices(fundId) });
  const mine: Notice[] = (notices.data ?? []).filter((n) => n.investorId === a.investorId && n.kind !== "reminder");
  return (
    <>
      <dl className="facts">
        <div><dt>Commitment</dt><dd>{exact(a.commitment)}</dd></div>
        <div><dt>Called</dt><dd>{exact(a.called)}</dd></div>
        <div><dt>Not yet paid</dt><dd>{exact(a.outstanding)}</dd></div>
        <div><dt>Catch-up at later closings</dt><dd>{exact(a.catchUp)}</dd></div>
        <div><dt>Credited when others joined</dt><dd>{exact(a.rebalancingCredit)}</dd></div>
        <div><dt>Equalisation interest paid</dt><dd>{exact(a.interestPaid)}</dd></div>
        <div><dt>Equalisation interest received</dt><dd>{exact(a.interestReceived)}</dd></div>
        <div><dt>Distributed</dt><dd>{exact(a.distributed)}</dd></div>
      </dl>
      {notices.isPending ? (
        <SkeletonRows rows={3} />
      ) : notices.isError ? (
        <ErrorState title="Notices did not load" error={notices.error} onRetry={() => notices.refetch()} />
      ) : mine.length === 0 ? (
        <EmptyState title="No notices yet">Notices appear once the fund calls or distributes capital.</EmptyState>
      ) : (
        <table>
          <thead>
            <tr><th>Notice</th><th>Issued</th><th className="num">Share</th><th className="num">Credit used</th><th className="num">Due</th><th className="num">Paid</th><th>Status</th></tr>
          </thead>
          <tbody>
            {mine.slice(0, layout.noticesPerInvestor).map((n) => (
              <tr key={n.id}>
                <td>{n.kind === "catch_up" ? "Closing catch-up" : n.kind === "call" ? "Capital call" : "Distribution"}</td>
                <td>{date(n.issuedOn)}</td>
                <td className="num">{exact(n.gross + n.interest)}</td>
                <td className="num">{n.creditApplied ? exact(n.creditApplied) : ""}</td>
                <td className="num">{n.kind === "distribution" ? "" : exact(n.amountDue)}</td>
                <td className="num">{n.kind === "distribution" ? "" : exact(n.paid)}</td>
                <td className={`status-${n.status}`}>{n.status === "info" ? "paid out" : n.status === "defaulted" ? "in default" : n.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
