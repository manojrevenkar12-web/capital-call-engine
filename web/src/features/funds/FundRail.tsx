import type { Fund } from "../../shared/api";
import { short } from "../../shared/format";
import { Skeleton } from "../../shared/ui";

export type View = { kind: "fund"; id: string } | { kind: "evaluation" };

interface Props {
  funds: Fund[] | undefined;
  loading: boolean;
  view: View | null;
  onSelect: (v: View) => void;
}

export function FundRail({ funds, loading, view, onSelect }: Props) {
  return (
    <nav className="rail" aria-label="Funds">
      <h1>Capital call engine</h1>
      <div className="rail-group">
        <p className="rail-label">Your funds</p>
        {loading
          ? [0, 1].map((i) => <Skeleton key={i} height="var(--s6)" />)
          : funds?.map((f) => (
              <button
                key={f.id}
                className="rail-item"
                aria-current={view?.kind === "fund" && view.id === f.id}
                onClick={() => onSelect({ kind: "fund", id: f.id })}
              >
                <span>{f.name}</span>
                <small>{short(f.committed)}</small>
              </button>
            ))}
      </div>
      <div className="rail-group">
        <p className="rail-label">How it was tested</p>
        <button className="rail-item" aria-current={view?.kind === "evaluation"} onClick={() => onSelect({ kind: "evaluation" })}>
          <span>Checked against the answer key</span>
        </button>
      </div>
    </nav>
  );
}
