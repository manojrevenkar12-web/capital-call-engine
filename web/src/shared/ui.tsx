import type { ReactNode } from "react";

export function Skeleton({ height, width = "100%" }: { height: string; width?: string }) {
  return <div className="skeleton" style={{ height, width }} aria-hidden="true" />;
}

export function SkeletonRows({ rows, height = "var(--s5)" }: { rows: number; height?: string }) {
  return (
    <div style={{ display: "grid", gap: "var(--s2)" }} aria-label="Loading" role="status">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={height} />
      ))}
    </div>
  );
}

export function ErrorState({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  return (
    <div className="state" role="alert">
      <h3>{title}</h3>
      <div>{error instanceof Error ? error.message : "Something went wrong."}</div>
      <button onClick={onRetry}>Try again</button>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="state">
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  );
}

export function SectionHead({ title, note }: { title: string; note?: ReactNode }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {note ? <p>{note}</p> : null}
    </div>
  );
}
