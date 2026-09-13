import { Sparkles } from "lucide-react";

export function AperoMark({ compact = false }: { compact?: boolean }) {
  return <div className="flex items-center gap-2.5"><span className="grid size-8 place-items-center rounded-[10px] bg-primary text-primary-foreground"><Sparkles className="size-4" /></span>{!compact && <span className="text-[20px] font-semibold text-foreground">Apero</span>}</div>;
}

export function ClinicBadge({ compact = false }: { compact?: boolean }) {
  return <div className="flex min-w-0 items-center gap-2.5"><span className="grid size-9 shrink-0 place-items-center rounded-full border border-success-border bg-success-soft font-semibold text-success">DZ</span>{!compact && <div className="min-w-0"><div className="truncate text-sm font-semibold">Dental Zone Clinic</div><div className="flex items-center gap-1 text-[11px] text-muted-foreground"><span className="size-1.5 rounded-full bg-success" />Apero Active</div></div>}</div>;
}
