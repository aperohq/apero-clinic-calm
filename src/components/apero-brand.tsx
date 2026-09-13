import { Sparkles } from "lucide-react";

export function AperoMark({ compact = false }: { compact?: boolean }) {
  return <div className="flex items-center gap-2.5"><span className="grid size-8 place-items-center rounded-[10px] bg-primary text-primary-foreground"><Sparkles className="size-4" /></span>{!compact && <span className="text-[20px] font-semibold text-foreground">Apero</span>}</div>;
}

function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((p) => p[0]).join("") || "?").toUpperCase();
}

export function ClinicBadge({ compact = false, name }: { compact?: boolean; name?: string | undefined }) {
  const clinicName = name?.trim() || "Your clinic";
  return <div className="flex min-w-0 items-center gap-2.5"><span className="grid size-9 shrink-0 place-items-center rounded-full border border-success-border bg-success-soft font-semibold text-success">{initialsOf(clinicName)}</span>{!compact && <div className="min-w-0"><div className="truncate text-sm font-semibold">{clinicName}</div><div className="flex items-center gap-1 text-[11px] text-muted-foreground"><span className="size-1.5 rounded-full bg-success" />Apero Active</div></div>}</div>;
}
