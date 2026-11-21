import type { ReactNode } from "react";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex min-w-0 flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div className="min-w-0">
        <h1 className="break-words [overflow-wrap:anywhere] text-2xl font-semibold text-foreground">
          {title}
        </h1>
        <p className="mt-1 break-words [overflow-wrap:anywhere] text-sm text-muted-foreground">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}
export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={cn(
        "min-w-0 rounded-2xl border border-border bg-card p-4 shadow-card [overflow-wrap:anywhere] sm:p-5",
        className,
      )}
    >
      {children}
    </section>
  );
}
export function PanelTitle({ children, detail }: { children: ReactNode; detail?: ReactNode }) {
  return (
    <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-3">
      <h2 className="min-w-0 break-words [overflow-wrap:anywhere] font-semibold">{children}</h2>
      {detail}
    </div>
  );
}
export function StatusBadge({ status }: { status: string }) {
  const success = ["Booked", "Completed", "Active"].includes(status);
  const warning = ["Needs Review", "Missed"].includes(status);
  return (
    <span
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        success
          ? "border-success-border bg-success-soft text-success-strong"
          : warning
            ? "border-warning-border bg-warning-soft text-warning-strong"
            : "border-border bg-muted text-muted-foreground",
      )}
    >
      {success ? (
        <CheckCircle2 className="size-3 shrink-0" aria-hidden="true" />
      ) : warning ? (
        <CircleAlert className="size-3 shrink-0" aria-hidden="true" />
      ) : null}
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">{status}</span>
    </span>
  );
}
export function Avatar({ initials, large = false }: { initials: string; large?: boolean }) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-primary font-semibold text-primary-foreground",
        large ? "size-14 text-base" : "size-9 text-xs",
      )}
    >
      {initials}
    </span>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
