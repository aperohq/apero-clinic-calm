import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertCircle, Check, Phone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Empty, PageHeader, Panel, PanelTitle } from "@/components/page-ui";
import { useAuth } from "@/lib/auth";
import { formatDate, formatTime } from "@/lib/apero-store";
import type { VoiceRequestRow } from "@/lib/db-types";
import { useCloseVoiceRequest, useVoiceRequests, type VoiceRequestDisplay } from "@/lib/voice-requests";
import { cn } from "@/lib/utils";

const kindLabel: Record<VoiceRequestRow["kind"], string> = {
  urgent: "Urgent request",
  callback: "Callback",
  message: "Message",
};

function priority(row: VoiceRequestDisplay) {
  return row.status === "Closed" ? 2 : row.kind === "urgent" ? 0 : 1;
}

function RequestCard({ row, timeZone }: { row: VoiceRequestDisplay; timeZone: string | undefined }) {
  const close = useCloseVoiceRequest();
  const [error, setError] = useState(false);
  const isUrgent = row.kind === "urgent" && row.status !== "Closed";
  const name = row.caller_name?.trim() || row.patient_name?.trim();
  return (
    <article
      className={cn(
        "rounded-xl border p-4",
        isUrgent ? "border-warning-border bg-warning-soft" : "border-border bg-card",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {isUrgent && <AlertCircle className="size-4 text-warning-strong" aria-hidden="true" />}
          <h3 className="font-semibold">{kindLabel[row.kind]}</h3>
          <span className="rounded-full border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground">
            {row.status}
          </span>
        </div>
        <time dateTime={row.created_at} className="text-xs text-muted-foreground">
          {formatDate(row.created_at, timeZone)} · {formatTime(row.created_at, timeZone)}
        </time>
      </div>
      <div className="mt-3 text-sm">
        {name && (
          <p className="break-words [overflow-wrap:anywhere] font-medium">
            {name}
            {row.caller_name && row.patient_name && row.caller_name !== row.patient_name ? (
              <span className="font-normal text-muted-foreground">
                {" "}
                · Patient: {row.patient_name}
              </span>
            ) : null}
          </p>
        )}
        <p className="mt-1 flex min-w-0 items-center gap-1 text-muted-foreground">
          <Phone className="size-3.5" aria-hidden="true" />
          <a href={`tel:${row.phone}`} className="min-w-0 break-all hover:underline">
            {row.phone}
          </a>
        </p>
      </div>
      <p className="mt-3 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm">{row.reason}</p>
      {row.status !== "Closed" && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            className="min-h-10"
            disabled={close.isPending}
            onClick={async () => {
              setError(false);
              try {
                await close.mutateAsync(row.id);
                toast.success("Request marked handled");
              } catch {
                setError(true);
              }
            }}
          >
            <Check className="size-4" />
            {close.isPending ? "Saving…" : "Mark handled"}
          </Button>
          {error && (
            <span role="alert" className="text-xs text-destructive">
              Could not save. Please try again.
            </span>
          )}
        </div>
      )}
    </article>
  );
}

function RequestState({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error: boolean;
  retry: () => void;
}) {
  if (loading)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading requests…
      </p>
    );
  if (error)
    return (
      <div role="alert" className="text-sm text-muted-foreground">
        Couldn’t load requests.{" "}
        <Button size="sm" variant="outline" className="ml-2" onClick={retry}>
          Try again
        </Button>
      </div>
    );
  return null;
}

export function HomeRequests() {
  const { profile, clinic } = useAuth();
  const query = useVoiceRequests();
  if (profile?.role === "staff") return null;
  const active = (query.data ?? [])
    .filter((row) => row.status !== "Closed")
    .sort(
      (a, b) => priority(a) - priority(b) || Date.parse(b.created_at) - Date.parse(a.created_at),
    );
  return (
    <Panel>
      <PanelTitle
        detail={
          <Link
            to="/requests"
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            View all
          </Link>
        }
      >
        Sara requests needing attention
      </PanelTitle>
      <RequestState
        loading={query.isPending}
        error={query.isError}
        retry={() => void query.refetch()}
      />
      {query.isSuccess &&
        (active.length ? (
          <div className="space-y-3">
            {active.slice(0, 3).map((row) => (
              <RequestCard key={row.id} row={row} timeZone={clinic?.timezone} />
            ))}
            {active.length > 3 && (
              <Link
                to="/requests"
                className="inline-block text-sm font-medium text-primary hover:underline"
              >
                View all {active.length} open requests
              </Link>
            )}
          </div>
        ) : (
          <Empty>No open requests from Sara.</Empty>
        ))}
    </Panel>
  );
}

export function RequestsPage() {
  const { clinic } = useAuth();
  const query = useVoiceRequests();
  const [showClosed, setShowClosed] = useState(false);
  const rows = (query.data ?? [])
    .filter((row) => showClosed || row.status !== "Closed")
    .sort(
      (a, b) => priority(a) - priority(b) || Date.parse(b.created_at) - Date.parse(a.created_at),
    );
  return (
    <>
      <PageHeader
        title="Requests"
        description="Messages and follow-ups Sara passed to your clinic."
      />
      <Panel>
        <PanelTitle
          detail={
            <Button size="sm" variant="outline" onClick={() => setShowClosed(!showClosed)}>
              {showClosed ? "Hide handled" : "Show handled"}
            </Button>
          }
        >
          {showClosed ? "All requests" : "Needs attention"}
          {query.isSuccess
            ? ` (${(query.data ?? []).filter((row) => row.status !== "Closed").length} open)`
            : ""}
        </PanelTitle>
        <RequestState
          loading={query.isPending}
          error={query.isError}
          retry={() => void query.refetch()}
        />
        {query.isSuccess &&
          (rows.length ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {rows.map((row) => (
                <RequestCard key={row.id} row={row} timeZone={clinic?.timezone} />
              ))}
            </div>
          ) : (
            <Empty>{showClosed ? "No requests yet." : "No open requests from Sara."}</Empty>
          ))}
      </Panel>
    </>
  );
}
