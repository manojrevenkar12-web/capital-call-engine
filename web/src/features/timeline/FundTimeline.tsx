import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useState } from "react";

import { color, layout, motion as m } from "../../app/tokens";
import { api, type TimelineEvent } from "../../shared/api";
import { date, exact, money, short } from "../../shared/format";
import { EmptyState, ErrorState, SectionHead, SkeletonRows } from "../../shared/ui";

const px = (n: number) => `${n}px`;
const MARK = {
  closing: { height: px(layout.closingMark), color: color.ledger },
  call: { height: px(layout.eventMark), color: color.owed },
  distribution: { height: px(layout.eventMark), color: color.credit },
} as const;

export function FundTimeline({ fundId }: { fundId: string }) {
  const timeline = useQuery({ queryKey: ["timeline", fundId], queryFn: () => api.timeline(fundId) });
  const [picked, setPicked] = useState<number | null>(null);
  const events = timeline.data ?? [];
  const closings = events.filter((e) => e.type === "closing");
  const later = closings.filter((c) => c.number > 1);
  const selected = picked ?? (later.length ? later[later.length - 1].number : null);

  return (
    <section aria-labelledby="timeline-title">
      <SectionHead
        title="Closings, calls and distributions"
        note={<span id="timeline-title">Pick a closing to see how it re-split the calls made before it</span>}
      />
      <div className="legend">
        <span><i className="swatch" style={{ background: color.ledger }} />Closing</span>
        <span><i className="swatch" style={{ background: color.owed }} />Capital call</span>
        <span><i className="swatch" style={{ background: color.credit }} />Distribution</span>
      </div>
      {timeline.isPending ? (
        <SkeletonRows rows={2} height="var(--s7)" />
      ) : timeline.isError ? (
        <ErrorState title="The fund's history did not load" error={timeline.error} onRetry={() => timeline.refetch()} />
      ) : events.length === 0 ? (
        <EmptyState title="Nothing has happened in this fund yet">The first closing starts the history.</EmptyState>
      ) : (
        <>
          <Axis events={events} selected={selected} onPick={setPicked} />
          <AnimatePresence mode="wait">
            {selected !== null ? <EqualisationLedger key={selected} fundId={fundId} number={selected} /> : null}
          </AnimatePresence>
        </>
      )}
    </section>
  );
}

function Axis({ events, selected, onPick }: { events: TimelineEvent[]; selected: number | null; onPick: (n: number) => void }) {
  const t = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const lo = t(events[0].date);
  const hi = Math.max(lo + 1, t(events[events.length - 1].date));
  const x = (d: string) => `${((t(d) - lo) / (hi - lo)) * 100}%`;
  return (
    <>
      <div className="timeline">
        <div className="timeline-axis" />
        {events.map((e) => {
          const mark = MARK[e.type];
          const label = e.type === "closing" ? `Closing ${e.number}` : e.type === "call" ? `Call ${e.number}, ${short(e.amount)}` : `Distribution ${e.number}, ${short(e.amount)}`;
          const style = { left: x(e.date), top: `calc(${px(layout.timelineAxis)} - ${mark.height})` };
          return e.type === "closing" ? (
            <button key={`${e.type}${e.number}`} className="tick" style={style} aria-pressed={selected === e.number} onClick={() => onPick(e.number)} title={`${label} on ${date(e.date)}`}>
              <span className="tick-label">{label}</span>
              <span className="tick-mark" style={{ height: mark.height, background: mark.color }} />
            </button>
          ) : (
            <span key={`${e.type}${e.number}`} className="tick" style={{ ...style, top: px(layout.timelineAxis), cursor: "default" }} title={`${label} on ${date(e.date)}`}>
              <span className="tick-mark" style={{ height: mark.height, background: mark.color }} />
            </span>
          );
        })}
      </div>
      <div className="timeline-years">
        <span>{date(events[0].date)}</span>
        <span>{date(events[events.length - 1].date)}</span>
      </div>
    </>
  );
}

function EqualisationLedger({ fundId, number }: { fundId: string; number: number }) {
  const reduce = useReducedMotion();
  const q = useQuery({ queryKey: ["equalisation", fundId, number], queryFn: () => api.equalisation(fundId, number) });
  const payers = (q.data?.investors ?? []).filter((i) => i.catchUp > 0).sort((a, b) => b.catchUp - a.catchUp);
  const receivers = (q.data?.investors ?? []).filter((i) => i.rebalancing > 0).sort((a, b) => b.rebalancing - a.rebalancing);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? undefined : { opacity: 0 }}
      transition={{ duration: m.expand, ease: m.ease }}
    >
      {q.isPending ? (
        <SkeletonRows rows={4} />
      ) : q.isError ? (
        <ErrorState title="This closing did not load" error={q.error} onRetry={() => q.refetch()} />
      ) : number === 1 || (payers.length === 0 && receivers.length === 0) ? (
        <EmptyState title={`Closing ${number} on ${q.data ? date(q.data.date) : ""}`}>
          {number === 1 ? "The first closing has no earlier calls to re-split." : "No calls had been made before this closing, so nobody owed or was owed anything."}
        </EmptyState>
      ) : (
        <div className="ledger">
          <div>
            <h3>Paid in at closing {number}</h3>
            <p className="total">
              {money(sum(payers.map((p) => p.catchUp)))} catch-up plus {exact(sum(payers.map((p) => p.interestPaid)))} equalisation interest, from investors joining or increasing on {date(q.data.date)}
            </p>
            <LedgerTable rows={payers.map((p) => ({ id: p.investorId, name: p.name, a: p.catchUp, b: p.interestPaid }))} b="Interest" />
          </div>
          <div>
            <h3>Credited to earlier investors</h3>
            <p className="total">
              {money(sum(receivers.map((r) => r.rebalancing)))} back to investors whose share of past calls went down, and the interest with it
            </p>
            <LedgerTable rows={receivers.map((r) => ({ id: r.investorId, name: r.name, a: r.rebalancing, b: r.interestReceived }))} b="Interest" />
          </div>
        </div>
      )}
    </motion.div>
  );
}

function LedgerTable({ rows, b }: { rows: { id: string; name: string; a: number; b: number }[]; b: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, layout.ledgerRowsBeforeFold);
  return (
    <>
    <table>
      <thead>
        <tr><th>Investor</th><th className="num">Capital</th><th className="num">{b}</th></tr>
      </thead>
      <tbody>
        {shown.map((r) => (
          <tr key={r.id}>
            <td>{r.name}</td>
            <td className="num">{exact(r.a)}</td>
            <td className="num">{exact(r.b)}</td>
          </tr>
        ))}
      </tbody>
    </table>
    {rows.length > layout.ledgerRowsBeforeFold ? (
      <button className="link-button" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${rows.length} investors`}</button>
    ) : null}
    </>
  );
}
