import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { notifyManager, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  EyeOff,
  FileText,
  Filter,
  Mail,
  MoreHorizontal,
  Phone,
  Plus,
  Search,
  Settings,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { AperoMark } from "@/components/apero-brand";
import { HomeRequests } from "@/components/requests";
import { Avatar, Empty, PageHeader, Panel, PanelTitle, StatusBadge } from "@/components/page-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth";
import { hasPermission, ROLE_LABELS } from "@/lib/permissions";
import { AccountAccessPanel } from "@/components/account-access-panel";
import { RecordingPlayer } from "@/components/recording-player";
import {
  DAY_NAMES,
  durationLabel,
  formatDate,
  formatDuration,
  formatTime,
  initialsOf,
  useAddClient,
  useAddClientNote,
  useAddStaff,
  useAppointments,
  useAvailability,
  useAppointmentSlots,
  useCancelAppointment,
  useClientNotes,
  useClients,
  useConversations,
  useCreateAppointment,
  useRescheduleAppointment,
  useRemoveTimeOff,
  useSaveAvailability,
  useSaveTimeOff,
  useStaff,
  useTimeOff,
  useUpdateClient,
  useUpdateStaff,
  type Client,
  type StaffMember,
} from "@/lib/apero-store";
import type {
  AppointmentRow,
  ConversationRow,
  StaffAvailabilityRow,
  StaffTimeOffRow,
} from "@/lib/db-types";
import { clinicDayBoundary, fromClinicInput, toClinicInput } from "@/lib/clinic-time";
import { calendarSegments, clinicWeek } from "@/lib/calendar-layout";
import { buildWeeklyRows, schedulePayload } from "@/lib/staff-schedule";
import { cn } from "@/lib/utils";

const field = "h-10 rounded-[10px]";
const EMPTY_AVAILABILITY: StaffAvailabilityRow[] = [];
const dash = (v: string | null | undefined) => (v && v.trim() ? v : "—");

function IconStat({
  icon: Icon,
  label,
  value,
  note,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  note: string;
}) {
  return (
    <Panel>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="mt-2 text-3xl font-semibold tabular-nums">{value}</p>
          <p className="mt-2 text-xs text-muted-foreground">{note}</p>
        </div>
        <span className="grid size-10 place-items-center rounded-xl bg-muted">
          <Icon className="size-5" />
        </span>
      </div>
    </Panel>
  );
}
function SearchBox({
  value,
  onChange,
  placeholder = "Search",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-label={placeholder}
        className={cn(field, "pl-9")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
function DataRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 gap-3 break-words border-b border-border px-1 py-4 [overflow-wrap:anywhere] last:border-0 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_auto] xl:items-center">
      {children}
    </div>
  );
}

function useDataStatus(keys: (string | readonly unknown[])[]) {
  const { clinicId } = useAuth();
  const queryClient = useQueryClient();
  const queryKeys = keys.map((key) => (typeof key === "string" ? [key, clinicId] : key));
  useSyncExternalStore(
    (listener) => queryClient.getQueryCache().subscribe(notifyManager.batchCalls(listener)),
    () =>
      queryKeys
        .map((key) => {
          const state = queryClient.getQueryState(key);
          return `${state?.status}:${state?.fetchStatus}`;
        })
        .join("|"),
    () => "",
  );
  if (!clinicId) return null;
  const states = queryKeys.map((key) => queryClient.getQueryState(key));
  if (states.some((state) => state?.status === "error"))
    return (
      <Panel>
        <Empty>
          We couldn’t load this page.{" "}
          <Button
            variant="outline"
            size="sm"
            className="ml-2"
            onClick={() =>
              queryKeys.forEach((key) => void queryClient.invalidateQueries({ queryKey: key }))
            }
          >
            Try again
          </Button>
        </Empty>
      </Panel>
    );
  if (states.some((state) => !state || state.status === "pending"))
    return (
      <Panel>
        <p className="text-sm text-muted-foreground" role="status">
          Loading clinic information…
        </p>
      </Panel>
    );
  return null;
}

function useClinicName() {
  const { clinic } = useAuth();
  return clinic?.name ?? "your clinic";
}
function clientStatus(bookings: number) {
  return bookings > 0 ? "Has bookings" : "No bookings yet";
}
function isUpcomingAppointment(appointment: AppointmentRow) {
  return appointment.status === "Booked" && Date.parse(appointment.start_time) >= Date.now();
}
type TranscriptTurn = { speaker: string; text: string; time: string };
function parseTranscript(value: unknown): TranscriptTurn[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (t): t is TranscriptTurn => !!t && typeof t === "object" && "speaker" in t && "text" in t,
  );
}

// ------------------------------------------------------------------ login
export function LoginPage() {
  const navigate = useNavigate();
  const { signIn, sendPasswordReset, session, loading, recoveringPassword } = useAuth();
  const [forgot, setForgot] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && session && !recoveringPassword) void navigate({ to: "/home", replace: true });
  }, [loading, session, recoveringPassword, navigate]);

  const submit = async () => {
    if (busy || loading || session) return;
    if (!email.trim() || !password) {
      setError("Enter your email and password to continue.");
      return;
    }
    setBusy(true);
    try {
      const { error: signInError } = await signIn(email, password);
      if (signInError) {
        setError(
          signInError === "Invalid login credentials"
            ? "Incorrect email or password."
            : "Couldn’t sign in. Please try again.",
        );
        return;
      }
      setError("");
      toast.success("Signed in");
    } catch {
      setError("Couldn’t sign in. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  if (loading || (session && !recoveringPassword))
    return (
      <main
        className="grid min-h-screen place-items-center bg-background p-6 text-sm text-muted-foreground"
        role="status"
      >
        Loading your clinic workspace…
      </main>
    );

  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <div className="w-full max-w-[430px]">
        <div className="mb-8 flex justify-center">
          <AperoMark />
        </div>
        <Panel className="p-7 sm:p-9">
          <h1 className="text-2xl font-semibold">Welcome back</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in to access your clinic dashboard.
          </p>
          {error && (
            <div
              role="alert"
              className="mt-5 rounded-[10px] border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {error}
            </div>
          )}
          <form
            className="mt-7 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div>
              <Label htmlFor="login-email">Email address</Label>
              <Input
                id="login-email"
                name="email"
                required
                disabled={busy}
                type="email"
                autoComplete="email"
                className={cn(field, "mt-2")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@clinic.com"
              />
            </div>
            <div>
              <div className="flex justify-between">
                <Label htmlFor="login-password">Password</Label>
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-xs"
                  onClick={() => {
                    setSent(false);
                    setForgot(true);
                  }}
                >
                  Forgot password?
                </Button>
              </div>
              <div className="relative">
                <Input
                  id="login-password"
                  name="password"
                  required
                  disabled={busy}
                  type={show ? "text" : "password"}
                  autoComplete="current-password"
                  className={cn(field, "mt-2 pr-10")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShow(!show)}
                  aria-label={show ? "Hide password" : "Show password"}
                  className="absolute right-0 top-2 grid size-10 place-items-center rounded-md text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>
            <Button type="submit" disabled={busy} className="h-10 w-full rounded-[10px]">
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </Panel>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Ask your clinic Owner for an invitation. Need help?{" "}
          <a className="font-semibold text-foreground underline" href="mailto:apero.hq@gmail.com">
            Contact Apero support
          </a>
        </p>
        <p className="mt-3 flex justify-center gap-4 text-xs text-muted-foreground">
          <Link to="/privacy" className="underline">
            Privacy
          </Link>
          <Link to="/terms" className="underline">
            Terms
          </Link>
        </p>
      </div>
      <Dialog open={forgot} onOpenChange={setForgot}>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>{sent ? "Check your email" : "Reset your password"}</DialogTitle>
            <DialogDescription>
              {sent
                ? "If this address has an account, check your email for a reset link."
                : "Enter your email and we’ll send you a secure reset link."}
            </DialogDescription>
          </DialogHeader>
          {sent ? (
            <CheckCircle2 className="mx-auto size-12 text-success" />
          ) : (
            <div>
              <Label htmlFor="reset-email">Email address</Label>
              <Input
                id="reset-email"
                type="email"
                className={cn(field, "mt-2")}
                value={resetEmail}
                onChange={(e) => setResetEmail(e.target.value)}
                placeholder="you@clinic.com"
              />
            </div>
          )}
          <DialogFooter>
            <Button
              className="rounded-[10px]"
              disabled={busy}
              onClick={async () => {
                if (sent) {
                  setForgot(false);
                  return;
                }
                if (!resetEmail.trim()) {
                  toast.error("Enter your email address first.");
                  return;
                }
                setBusy(true);
                try {
                  const { error: resetError } = await sendPasswordReset(resetEmail);
                  if (resetError) {
                    toast.error("Could not send the reset link. Please try again.");
                    return;
                  }
                  setSent(true);
                } catch {
                  toast.error("Could not send the reset link. Please try again.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {sent ? "Return to sign in" : busy ? "Sending…" : "Send reset link"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const { updatePassword, session, loading, recoveringPassword } = useAuth();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const rules = [pw.length >= 8, /[A-Z]/.test(pw), /\d/.test(pw)];
  const ready = rules.every(Boolean) && pw === confirm;
  const validLink = !!session && recoveringPassword;
  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <div className="w-full max-w-[430px]">
        <div className="mb-8 flex justify-center">
          <AperoMark />
        </div>
        <Panel className="p-7 sm:p-9">
          <h1 className="text-2xl font-semibold">Choose a new password</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {loading
              ? "Checking your reset link…"
              : validLink
                ? "Enter a new password for your Apero account."
                : "This reset link is invalid or has expired. Request a new link from the sign-in page."}
          </p>
          {validLink && (
            <div className="mt-6 grid gap-4">
              <div>
                <Label htmlFor="new-pw">New password</Label>
                <Input
                  id="new-pw"
                  type="password"
                  autoComplete="new-password"
                  className={cn(field, "mt-2")}
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="confirm-pw">Confirm password</Label>
                <Input
                  id="confirm-pw"
                  type="password"
                  autoComplete="new-password"
                  className={cn(field, "mt-2")}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>
              <div className="space-y-2 rounded-xl bg-muted p-3 text-xs">
                {["At least 8 characters", "At least 1 uppercase letter", "At least 1 number"].map(
                  (r, i) => (
                    <div
                      key={r}
                      className={cn(
                        "flex items-center gap-2",
                        rules[i] ? "text-success-strong" : "text-muted-foreground",
                      )}
                    >
                      <CheckCircle2 className="size-3" />
                      {r}
                    </div>
                  ),
                )}
              </div>
              <Button
                disabled={!ready || busy}
                onClick={async () => {
                  if (busy) return;
                  setBusy(true);
                  try {
                    const { error } = await updatePassword(pw);
                    if (error) {
                      toast.error("Could not update the password.");
                      return;
                    }
                    toast.success("Password updated");
                    void navigate({ to: "/home" });
                  } catch {
                    toast.error("Could not update the password.");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Updating…" : "Update password"}
              </Button>
            </div>
          )}
          <Button variant="ghost" className="mt-4" asChild>
            <Link to="/login">Back to sign in</Link>
          </Button>
        </Panel>
      </div>
    </main>
  );
}

// ------------------------------------------------------------------- home
export function HomePage() {
  const { profile, clinic } = useAuth();
  const clinicName = useClinicName();
  const clients = useClients();
  const staffList = useStaff();
  const appointments = useAppointments();
  const conversations = useConversations();
  const dataStatus = useDataStatus(["clients", "staff", "appointments", "conversations"]);
  const clientOf = (id: string | null) => clients.find((c) => c.id === id);
  const attention = conversations.filter(
    (c) => ["Needs Review", "Missed"].includes(c.status) || c.outcome === "Follow-up Needed",
  );
  const next = appointments.find(
    (a) => a.status === "Booked" && new Date(a.start_time).getTime() >= Date.now(),
  );
  const nextClient = clientOf(next?.client_id ?? null);
  const nextStaff = staffList.find((s) => s.id === next?.staff_id);
  const booked = appointments.filter(isUpcomingAppointment).length;
  if (dataStatus) return dataStatus;
  const displayDate = (iso: string) => formatDate(iso, clinic?.timezone);
  const displayTime = (iso: string) => formatTime(iso, clinic?.timezone);
  return (
    <>
      <PageHeader
        title={`Welcome, ${profile?.full_name ?? "there"}`}
        description={`Here’s what’s happening at ${clinicName}.`}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <IconStat
          icon={Phone}
          label="Conversations"
          value={String(conversations.length)}
          note="In your call history"
        />
        <IconStat
          icon={CalendarDays}
          label="Appointments booked"
          value={String(booked)}
          note="Currently scheduled"
        />
        <IconStat
          icon={Clock}
          label="Calls needing attention"
          value={String(attention.length)}
          note="Review in Conversations"
        />
        <IconStat
          icon={Users}
          label="Clients"
          value={String(clients.length)}
          note="In your clinic records"
        />
      </div>
      <div className="mt-6">
        <HomeRequests />
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-[1.35fr_.65fr]">
        <Panel>
          <PanelTitle
            detail={
              <Link
                to="/conversations"
                className="text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                View all
              </Link>
            }
          >
            Calls needing review
          </PanelTitle>
          <div className="space-y-3">
            {attention.length ? (
              attention.slice(0, 4).map((c) => {
                const client = clientOf(c.client_id);
                return (
                  <Link
                    key={c.id}
                    to="/conversations/$id"
                    params={{ id: c.id }}
                    className="flex items-center gap-3 rounded-xl border border-warning-border bg-warning-soft p-4"
                  >
                    <Avatar initials={client?.initials ?? "?"} />
                    <div className="min-w-0 flex-1">
                      <div className="break-words [overflow-wrap:anywhere] font-medium">
                        {c.title}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {client?.name ?? dash(c.caller_phone)} · {displayTime(c.started_at)}
                      </div>
                    </div>
                    <StatusBadge status={c.status} />
                  </Link>
                );
              })
            ) : (
              <Empty>Nothing needs your attention.</Empty>
            )}
          </div>
        </Panel>
        <Panel>
          <PanelTitle>Next appointment</PanelTitle>
          {next ? (
            <>
              <p className="text-2xl font-semibold">{displayTime(next.start_time)}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {displayDate(next.start_time)} · {durationLabel(next.start_time, next.end_time)}
              </p>
              <div className="my-5 flex min-w-0 items-center gap-3">
                <Avatar initials={nextClient?.initials ?? "?"} />
                <div className="min-w-0 break-words [overflow-wrap:anywhere]">
                  {nextClient ? (
                    <Link
                      to="/clients/$id"
                      params={{ id: nextClient.id }}
                      className="font-semibold hover:underline"
                    >
                      {nextClient.name}
                    </Link>
                  ) : (
                    <span className="font-semibold">Unknown client</span>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {next.service} · {nextStaff?.name ?? "Unassigned"}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={next.status} />
                <Button size="sm" variant="outline" asChild>
                  <Link to="/calendar">Open in calendar</Link>
                </Button>
                {nextClient && (
                  <Button size="sm" variant="ghost" asChild>
                    <Link to="/clients/$id" params={{ id: nextClient.id }}>
                      View client
                    </Link>
                  </Button>
                )}
              </div>
            </>
          ) : (
            <Empty>No upcoming appointments.</Empty>
          )}
        </Panel>
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-[1.35fr_.65fr]">
        <Panel>
          <PanelTitle
            detail={
              <Link
                to="/conversations"
                className="text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Open call log
              </Link>
            }
          >
            Recent conversations
          </PanelTitle>
          {conversations.length ? (
            conversations.slice(0, 4).map((c) => {
              const client = clientOf(c.client_id);
              return (
                <DataRow key={c.id}>
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar initials={client?.initials ?? "?"} />
                    <div className="min-w-0 break-words [overflow-wrap:anywhere]">
                      <Link
                        to="/conversations/$id"
                        params={{ id: c.id }}
                        className="font-medium hover:underline"
                      >
                        {client?.name ?? dash(c.caller_phone)}
                      </Link>
                      <p className="break-words text-xs text-muted-foreground">{c.title}</p>
                    </div>
                  </div>
                  <span className="text-sm text-muted-foreground">{displayTime(c.started_at)}</span>
                  <span className="text-sm tabular-nums">{formatDuration(c.duration_seconds)}</span>
                  <StatusBadge status={c.status} />
                </DataRow>
              );
            })
          ) : (
            <Empty>No conversations yet.</Empty>
          )}
        </Panel>
        <Panel>
          <PanelTitle>Clinic workspace</PanelTitle>
          <p className="text-sm text-muted-foreground">
            Review calls, bookings, clients, and team schedules from one place.
          </p>
          <Button variant="outline" className="mt-5" asChild>
            <Link to="/calendar">Open calendar</Link>
          </Button>
        </Panel>
      </div>
    </>
  );
}

// --------------------------------------------------------------- calendar
const weekDayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function CalendarPage() {
  const staffList = useStaff();
  const clients = useClients();
  const { clinic, clinicId } = useAuth();
  const timeZone = clinic?.timezone ?? "UTC";
  const [staffFilter, setStaffFilter] = useState("all");
  const [dialog, setDialog] = useState<"new" | "details" | null>(null);
  const [selected, setSelected] = useState<AppointmentRow | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const todayDate = toClinicInput(new Date().toISOString(), timeZone).slice(0, 10);
  const week = useMemo(() => {
    return clinicWeek(new Date(`${todayDate}T12:00:00Z`), "UTC", weekOffset).map((date, i) => ({
      name: weekDayNames[i],
      label: `${weekDayNames[i]} ${date.getUTCDate()}`,
      date,
    }));
  }, [weekOffset, todayDate]);
  const windowStart = clinicDayBoundary(week[0]!.date.toISOString().slice(0, 10), timeZone);
  const nextWeek = new Date(week[6]!.date);
  nextWeek.setUTCDate(nextWeek.getUTCDate() + 1);
  const windowEnd = clinicDayBoundary(nextWeek.toISOString().slice(0, 10), timeZone);
  const appointments = useAppointments({ start: windowStart, end: windowEnd });
  const dataStatus = useDataStatus([
    "staff",
    ["appointments", clinicId, windowStart, windowEnd],
    "clients",
  ]);
  const first = week[0]!;
  const last = week[6]!;
  const rangeLabel = `${monthNames[first.date.getUTCMonth()]} ${first.date.getUTCDate()}–${first.date.getUTCMonth() === last.date.getUTCMonth() ? "" : `${monthNames[last.date.getUTCMonth()]} `}${last.date.getUTCDate()}, ${last.date.getUTCFullYear()}`;
  const segments = calendarSegments(
    appointments,
    week.map((d) => d.date),
    timeZone,
    staffFilter,
  );
  const visible = [...new Set(segments.map((s) => s.appointment))];
  const firstHour = Math.min(7, ...segments.map((s) => Math.floor(s.start / 60)));
  const lastHour = Math.max(22, ...segments.map((s) => Math.ceil(s.end / 60)));
  const hourCount = lastHour - firstHour;
  const clientName = (id: string | null) =>
    clients.find((c) => c.id === id)?.name ?? "Unknown client";
  if (dataStatus) return dataStatus;
  return (
    <>
      <PageHeader
        title="Calendar"
        description={`${rangeLabel} · Clinic time`}
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              className="rounded-[10px]"
              onClick={() => {
                setSelected(null);
                setDialog("new");
              }}
            >
              <Plus />
              New appointment
            </Button>
          </div>
        }
      />
      <Panel className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
          <div className="flex gap-2">
            <Button
              size="icon"
              variant="outline"
              className="size-10"
              aria-label="Previous week"
              onClick={() => setWeekOffset(weekOffset - 1)}
            >
              <ChevronLeft />
            </Button>
            <Button variant="outline" onClick={() => setWeekOffset(0)}>
              Today
            </Button>
            <Button
              size="icon"
              variant="outline"
              className="size-10"
              aria-label="Next week"
              onClick={() => setWeekOffset(weekOffset + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
          <Select value={staffFilter} onValueChange={setStaffFilter}>
            <SelectTrigger className="w-full sm:w-[210px]">
              <Filter />
              <SelectValue placeholder="All staff" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All staff</SelectItem>
              {staffList.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground lg:hidden">
          Scroll sideways to see the full week.
        </p>
        <div
          className="overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label="Weekly appointment calendar"
        >
          <div className="min-w-[1050px]">
            <div className="grid grid-cols-[70px_repeat(7,1fr)] border-b border-border bg-muted/40">
              <div />
              {week.map((d) => (
                <div
                  key={d.label}
                  className={cn(
                    "border-l border-border p-3 text-center text-sm font-semibold",
                    d.date.toISOString().slice(0, 10) === todayDate &&
                      "bg-nav-active text-foreground",
                  )}
                  aria-current={
                    d.date.toISOString().slice(0, 10) === todayDate ? "date" : undefined
                  }
                >
                  {d.label}
                </div>
              ))}
            </div>
            <div
              className="relative grid grid-cols-[70px_repeat(7,1fr)]"
              style={{
                height: hourCount * 60,
                gridTemplateRows: `repeat(${hourCount}, minmax(0, 1fr))`,
              }}
            >
              {Array.from({ length: hourCount }, (_, i) => {
                const hour = i + firstHour;
                return `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;
              }).map((t, i) => (
                <div
                  key={t}
                  className="col-span-8 grid grid-cols-[70px_1fr] border-b border-border"
                  style={{ gridRow: i + 1 }}
                >
                  <span className="p-2 text-right text-[11px] text-muted-foreground">{t}</span>
                  <span className="border-l border-border" />
                </div>
              ))}
              {segments.map(({ appointment: a, day, start, end, lane, lanes }) => (
                <Button
                  key={`${a.id}-${day}`}
                  variant="outline"
                  onClick={() => {
                    setSelected(a);
                    setDialog("details");
                  }}
                  aria-label={`${clientName(a.client_id)}, ${a.service}, ${formatTime(a.start_time, timeZone)}, ${durationLabel(a.start_time, a.end_time)}`}
                  className={cn(
                    "absolute z-10 items-start justify-start overflow-hidden whitespace-normal p-2 text-left",
                    a.status === "Booked"
                      ? "border-success-border bg-success-soft text-success-strong hover:bg-success-soft"
                      : "border-border bg-muted text-muted-foreground hover:bg-muted",
                  )}
                  style={{
                    top: start - firstHour * 60,
                    height: Math.max(24, end - start),
                    left: `calc(70px + (100% - 70px) * ${(day + lane / lanes) / 7} + 2px)`,
                    width: `calc((100% - 70px) / ${7 * lanes} - 4px)`,
                  }}
                >
                  <span>
                    <b className="block text-xs">{formatTime(a.start_time, timeZone)}</b>
                    <span className="block break-words [overflow-wrap:anywhere] text-xs">
                      {clientName(a.client_id)}
                    </span>
                    <span className="block break-words [overflow-wrap:anywhere] text-[10px] opacity-75">
                      {a.service}
                    </span>
                  </span>
                </Button>
              ))}
            </div>
          </div>
        </div>
        {!visible.length && (
          <div className="border-t border-border p-4 text-center text-sm text-muted-foreground">
            No appointments scheduled for this week.
          </div>
        )}
      </Panel>
      <AppointmentDialog
        mode={dialog}
        onClose={() => {
          setDialog(null);
          setSelected(null);
        }}
        appointment={selected}
        onSaved={(start) => {
          const target = clinicWeek(new Date(start), timeZone, 0)[0]!;
          const current = clinicWeek(new Date(), timeZone, 0)[0]!;
          setWeekOffset(Math.round((target.getTime() - current.getTime()) / (7 * 86400000)));
        }}
      />
    </>
  );
}

function AppointmentDialog({
  mode,
  onClose,
  appointment,
  onSaved,
}: {
  onSaved: (start: string) => void;
  mode: "new" | "details" | null;
  onClose: () => void;
  appointment: AppointmentRow | null;
}) {
  const clientList = useClients();
  const staffList = useStaff();
  const { clinic } = useAuth();
  const timeZone = clinic?.timezone ?? "UTC";
  const create = useCreateAppointment();
  const reschedule = useRescheduleAppointment();
  const cancel = useCancelAppointment();
  const [action, setAction] = useState<"view" | "reschedule" | "cancel">("view");
  const [clientId, setClientId] = useState("");
  const [staffId, setStaffId] = useState("");
  const [service, setService] = useState("");
  const [date, setDate] = useState("");
  const [slotStart, setSlotStart] = useState("");
  const [reason, setReason] = useState("");
  const detail = mode === "details" && appointment !== null;
  const choosingSlot = mode === "new" || (detail && action === "reschedule");
  const slots = useAppointmentSlots(
    staffId,
    service,
    date,
    detail ? appointment.id : null,
    choosingSlot,
  );
  const selectedSlot = slots.data?.find((slot) => slot.start_time === slotStart);
  const services = staffList.find((s) => s.id === staffId)?.services ?? [];
  const changeDate = (value: string) => {
    setDate(value);
    setSlotStart("");
  };

  useEffect(() => {
    if (!mode) return;
    setAction("view");
    setReason("");
    const local = toClinicInput(appointment?.start_time ?? new Date().toISOString(), timeZone);
    setDate(local.slice(0, 10));
    setSlotStart("");
    setClientId(appointment?.client_id ?? "");
    setStaffId(appointment?.staff_id ?? "");
    setService(appointment?.service ?? "");
  }, [mode, appointment, timeZone]);

  if (!mode) return null;
  const isSaving = create.isPending || reschedule.isPending || cancel.isPending;
  const appointmentClient = clientList.find((c) => c.id === (appointment?.client_id ?? clientId));

  const save = async () => {
    if (action !== "cancel" && !selectedSlot) {
      toast.error("Choose an available slot in the clinic timezone.");
      return;
    }
    try {
      if (detail && action === "cancel" && appointment) {
        await cancel.mutateAsync({ id: appointment.id, reason });
        toast.success("Appointment cancelled");
      } else if (detail && appointment) {
        await reschedule.mutateAsync({ id: appointment.id, slot: selectedSlot! });
        toast.success("Appointment rescheduled");
      } else {
        if (!clientId || !staffId || !service.trim()) {
          toast.error("Choose a client, a practitioner and a service.");
          return;
        }
        await create.mutateAsync({ clientId, staffId, service, slot: selectedSlot! });
        toast.success("Appointment created");
      }
      if (action !== "cancel" && selectedSlot) onSaved(selectedSlot.start_time);
      onClose();
    } catch (error) {
      toast.error(
        error &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
          ? error.message
          : "Could not save the appointment. Refresh availability and try again.",
      );
      if (choosingSlot) {
        setSlotStart("");
        void slots.refetch();
      }
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !isSaving) {
          setAction("view");
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto rounded-2xl">
        <DialogHeader>
          <DialogTitle>
            {mode === "new"
              ? "New Appointment"
              : action === "reschedule"
                ? "Reschedule Appointment"
                : action === "cancel"
                  ? "Cancel Appointment"
                  : "Appointment Details"}
          </DialogTitle>
          <DialogDescription>
            {detail
              ? `${appointmentClient?.name ?? "Client"} · ${appointment?.service}`
              : "Update the clinic calendar."}
          </DialogDescription>
        </DialogHeader>
        {detail && action === "view" ? (
          <div className="space-y-3 rounded-xl bg-muted p-4 text-sm">
            <p>
              <b>Time:</b>{" "}
              {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone }).format(
                new Date(appointment.start_time),
              )}
              ,{" "}
              {new Intl.DateTimeFormat(undefined, { timeStyle: "short", timeZone }).format(
                new Date(appointment.start_time),
              )}
            </p>
            <p>
              <b>Duration:</b> {durationLabel(appointment.start_time, appointment.end_time)}
            </p>
            {appointmentClient?.phone && (
              <p>
                <b>Phone:</b> {appointmentClient.phone}
              </p>
            )}
            {appointment.source && (
              <p>
                <b>Source:</b> {appointment.source}
              </p>
            )}
            {appointment.notes && (
              <p className="whitespace-pre-wrap">
                <b>Notes:</b> {appointment.notes}
              </p>
            )}
            <p>
              <b>Practitioner:</b>{" "}
              {staffList.find((s) => s.id === appointment.staff_id)?.name ?? "Unassigned"}
            </p>
            <p>
              <b>Service:</b> {appointment.service}
            </p>
            <StatusBadge status={appointment.status} />
          </div>
        ) : action === "cancel" ? (
          <Textarea
            aria-label="Cancellation reason"
            placeholder="Cancellation reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        ) : (
          <div className="grid gap-4">
            {!detail && (
              <div>
                <Label>Client</Label>
                <Select value={clientId} onValueChange={setClientId}>
                  <SelectTrigger aria-label="Client" className="mt-2">
                    <SelectValue placeholder="Select a client" />
                  </SelectTrigger>
                  <SelectContent>
                    {clientList.map((c) => (
                      <SelectItem value={c.id} key={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {!detail && (
              <div>
                <Label>Practitioner</Label>
                <Select
                  value={staffId}
                  onValueChange={(value) => {
                    setStaffId(value);
                    setService("");
                    setSlotStart("");
                  }}
                >
                  <SelectTrigger aria-label="Practitioner" className="mt-2">
                    <SelectValue placeholder="Select a practitioner" />
                  </SelectTrigger>
                  <SelectContent>
                    {staffList
                      .filter((s) => s.active)
                      .map((s) => (
                        <SelectItem value={s.id} key={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {!detail && (
              <div>
                <Label>Service</Label>
                <Select
                  value={service}
                  onValueChange={(value) => {
                    setService(value);
                    setSlotStart("");
                  }}
                >
                  <SelectTrigger aria-label="Service" className="mt-2">
                    <SelectValue placeholder="Select a service" />
                  </SelectTrigger>
                  <SelectContent>
                    {services.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid gap-3">
              <Input
                aria-label="Appointment date"
                type="date"
                min={toClinicInput(new Date().toISOString(), timeZone).slice(0, 10)}
                value={date}
                onChange={(e) => changeDate(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Times in {timeZone}</p>
              {!staffId || !service ? (
                <p className="text-sm text-muted-foreground">
                  Choose a practitioner and service to see availability.
                </p>
              ) : slots.isPending ? (
                <p role="status" className="text-sm">
                  Loading available slots…
                </p>
              ) : slots.isError ? (
                <p role="alert" className="text-sm">
                  Could not load availability.{" "}
                  <Button variant="outline" size="sm" onClick={() => void slots.refetch()}>
                    Try again
                  </Button>
                </p>
              ) : !slots.data?.length ? (
                <p className="text-sm text-muted-foreground">No available slots on this date.</p>
              ) : (
                <Select value={selectedSlot ? slotStart : ""} onValueChange={setSlotStart}>
                  <SelectTrigger aria-label="Available appointment time">
                    <SelectValue placeholder="Select an available time" />
                  </SelectTrigger>
                  <SelectContent>
                    {slots.data.map((slot) => (
                      <SelectItem key={slot.start_time} value={slot.start_time}>
                        {formatTime(slot.start_time, timeZone)} · {slot.duration_minutes} min
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          {detail && action === "view" ? (
            <>
              {appointment.status === "Booked" && (
                <>
                  <Button variant="destructive" onClick={() => setAction("cancel")}>
                    Cancel appointment
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSlotStart("");
                      setAction("reschedule");
                    }}
                  >
                    Reschedule
                  </Button>
                </>
              )}
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={isSaving}
                onClick={() => {
                  setAction("view");
                  onClose();
                }}
              >
                Cancel
              </Button>
              <Button
                disabled={
                  isSaving ||
                  (action !== "cancel" &&
                    (!selectedSlot || slots.isFetching || (mode === "new" && !clientId)))
                }
                onClick={() => void save()}
              >
                {create.isPending || reschedule.isPending || cancel.isPending
                  ? "Saving…"
                  : action === "cancel"
                    ? "Confirm cancellation"
                    : "Save"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- clients
function AddClientDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const addClient = useAddClient();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const submit = async () => {
    if (!name.trim() || !phone.trim()) {
      setError("Full name and phone number are required.");
      return;
    }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    try {
      await addClient.mutateAsync({ name, phone, email, notes });
      setError("");
      setName("");
      setPhone("");
      setEmail("");
      setNotes("");
      onOpenChange(false);
      toast.success("Client added successfully");
    } catch {
      setError("Could not save the client. Please try again.");
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!addClient.isPending) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto rounded-2xl">
        <DialogHeader>
          <DialogTitle>Add client</DialogTitle>
          <DialogDescription>Create a client profile for your clinic.</DialogDescription>
        </DialogHeader>
        {error && (
          <div className="rounded-[10px] border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
        <div className="grid gap-4">
          <div>
            <Label htmlFor="client-name">Full name</Label>
            <Input
              id="client-name"
              className={cn(field, "mt-2")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Client full name"
            />
          </div>
          <div>
            <Label htmlFor="client-phone">Phone number</Label>
            <Input
              id="client-phone"
              type="tel"
              inputMode="tel"
              className={cn(field, "mt-2")}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+965 9912 3456"
            />
          </div>
          <div>
            <Label htmlFor="client-email">
              Email address <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="client-email"
              type="email"
              inputMode="email"
              className={cn(field, "mt-2")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="client@example.com"
            />
          </div>
          <div>
            <Label htmlFor="client-notes">
              Notes <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="client-notes"
              className="mt-2"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything the team should know"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={addClient.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button disabled={addClient.isPending} onClick={() => void submit()}>
            {addClient.isPending ? "Saving…" : "Add client"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditClientDialog({ client, onClose }: { client: Client | null; onClose: () => void }) {
  const updateClient = useUpdateClient();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  useEffect(() => {
    if (client) {
      setName(client.full_name);
      setPhone(client.phone);
      setEmail(client.email ?? "");
    }
  }, [client]);
  if (!client) return null;
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !updateClient.isPending) onClose();
      }}
    >
      <DialogContent className="rounded-2xl">
        <DialogHeader>
          <DialogTitle>Edit client</DialogTitle>
          <DialogDescription>Update {client.name}'s contact details.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div>
            <Label htmlFor="edit-client-name">Full name</Label>
            <Input
              id="edit-client-name"
              className={cn(field, "mt-2")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="edit-client-phone">Phone number</Label>
            <Input
              id="edit-client-phone"
              className={cn(field, "mt-2")}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="edit-client-email">Email address</Label>
            <Input
              id="edit-client-email"
              className={cn(field, "mt-2")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={updateClient.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={updateClient.isPending}
            onClick={async () => {
              if (!name.trim() || !phone.trim()) {
                toast.error("Full name and phone number are required.");
                return;
              }
              try {
                await updateClient.mutateAsync({
                  id: client.id,
                  full_name: name.trim(),
                  phone: phone.trim(),
                  email: email.trim() || null,
                });
                toast.success("Client updated");
                onClose();
              } catch {
                toast.error("Could not update the client.");
              }
            }}
          >
            {updateClient.isPending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ClientsPage() {
  const { clinic, role } = useAuth();
  const clientList = useClients();
  const appointments = useAppointments();
  const dataStatus = useDataStatus(["clients", "appointments"]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const bookingsOf = (id: string) => appointments.filter((a) => a.client_id === id).length;
  const rows = clientList.filter(
    (c) =>
      `${c.name} ${c.phone} ${c.email ?? ""}`.toLowerCase().includes(q.toLowerCase()) &&
      (status === "all" || clientStatus(bookingsOf(c.id)) === status),
  );
  const copy = (value: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard
        .writeText(value)
        .then(() => toast.success("Phone number copied"))
        .catch(() => toast.error("Could not copy the number"));
    } else toast.error("Copying is not available here");
  };
  if (dataStatus) return dataStatus;
  const displayDate = (iso: string) => formatDate(iso, clinic?.timezone);
  const displayTime = (iso: string) => formatTime(iso, clinic?.timezone);
  return (
    <>
      <PageHeader
        title="Clients"
        description={`${clientList.length} client profiles in your clinic.`}
        action={
          hasPermission(role, "clients.create") ? (
            <Button onClick={() => setOpen(true)}>
              <Plus />
              Add client
            </Button>
          ) : undefined
        }
      />
      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <IconStat
          icon={Users}
          label="Client records"
          value={String(clientList.length)}
          note="in your clinic"
        />
        <IconStat
          icon={CalendarDays}
          label="Active bookings"
          value={String(appointments.filter(isUpcomingAppointment).length)}
          note="scheduled"
        />
        <IconStat
          icon={Clock}
          label="Past appointments"
          value={String(appointments.filter((a) => Date.parse(a.start_time) < Date.now()).length)}
          note="on record"
        />
      </div>
      <Panel>
        <div className="mb-4 flex flex-col gap-3 sm:flex-row">
          <div className="flex-1 sm:max-w-md">
            <SearchBox value={q} onChange={setQ} placeholder="Search clients" />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-full sm:w-[190px]">
              <Filter />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All clients</SelectItem>
              <SelectItem value="Has bookings">Has bookings</SelectItem>
              <SelectItem value="No bookings yet">No bookings yet</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {rows.length ? (
          rows.map((c) => {
            const apt = appointments.find((a) => a.client_id === c.id && isUpcomingAppointment(a));
            const bookings = bookingsOf(c.id);
            return (
              <DataRow key={c.id}>
                <div className="flex items-center gap-3">
                  <Avatar initials={c.initials} />
                  <div className="min-w-0">
                    <Link
                      to="/clients/$id"
                      params={{ id: c.id }}
                      className="font-semibold hover:underline"
                    >
                      {c.name}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {c.phone} · {dash(c.email)}
                    </p>
                  </div>
                </div>
                <div className="text-sm">
                  <p>{clientStatus(bookings)}</p>
                  <p className="text-xs text-muted-foreground">{bookings} bookings</p>
                </div>
                <div className="text-sm">
                  {apt ? (
                    <>
                      <p>{apt.service}</p>
                      <p className="text-xs text-muted-foreground">
                        {displayDate(apt.start_time)} · {displayTime(apt.start_time)}
                      </p>
                    </>
                  ) : (
                    <span className="text-muted-foreground">No upcoming appointment</span>
                  )}
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label={`Actions for ${c.name}`}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem asChild>
                      <Link to="/clients/$id" params={{ id: c.id }}>
                        View profile
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setEditing(c)}>Edit client</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => copy(c.phone)}>
                      Copy phone number
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link to="/calendar">Book appointment</Link>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </DataRow>
            );
          })
        ) : (
          <Empty>{clientList.length ? "No clients match your search." : "No clients yet."}</Empty>
        )}
      </Panel>
      <AddClientDialog open={open} onOpenChange={setOpen} />
      <EditClientDialog client={editing} onClose={() => setEditing(null)} />
    </>
  );
}

export function ClientDetailPage({ id }: { id: string }) {
  const { clinic } = useAuth();
  const clientList = useClients();
  const appointments = useAppointments();
  const conversations = useConversations();
  const staffList = useStaff();
  const notesQuery = useClientNotes(id);
  const notes = notesQuery.data ?? [];
  const addNote = useAddClientNote();
  const dataStatus = useDataStatus(["clients", "appointments", "conversations", "staff"]);
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<Client | null>(null);
  const c = clientList.find((x) => x.id === id);
  if (dataStatus) return dataStatus;
  if (notesQuery.isPending)
    return (
      <Panel>
        <p className="text-sm text-muted-foreground" role="status">
          Loading client details…
        </p>
      </Panel>
    );
  if (notesQuery.isError)
    return (
      <Panel>
        <Empty>
          Could not load this client’s notes.{" "}
          <Button
            variant="outline"
            size="sm"
            className="ml-2"
            onClick={() => void notesQuery.refetch()}
          >
            Try again
          </Button>
        </Empty>
      </Panel>
    );
  if (!c)
    return (
      <>
        <Link
          to="/clients"
          className="mb-5 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to Clients
        </Link>
        <Empty>This client could not be found.</Empty>
      </>
    );
  const related = appointments.filter((a) => a.client_id === c.id);
  const upcoming = related.filter(isUpcomingAppointment);
  const history = related.filter((a) => !isUpcomingAppointment(a));
  const calls = conversations.filter((x) => x.client_id === c.id);
  const bookings = related.length;
  const displayDate = (iso: string) => formatDate(iso, clinic?.timezone);
  const displayTime = (iso: string) => formatTime(iso, clinic?.timezone);
  return (
    <>
      <Link
        to="/clients"
        className="mb-5 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to Clients
      </Link>
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <Avatar initials={c.initials} large />
        <div className="mr-auto min-w-0">
          <h1 className="break-words text-2xl font-semibold">{c.name}</h1>
          <p className="text-sm text-muted-foreground">
            {clientStatus(bookings)} · {bookings} bookings
          </p>
        </div>
        <Button variant="outline" onClick={() => setEditing(c)}>
          Edit client
        </Button>
        <Button asChild>
          <Link to="/calendar">
            <Plus />
            Book appointment
          </Link>
        </Button>
      </div>
      <div className="grid gap-6 xl:grid-cols-[1.35fr_.65fr]">
        <div className="space-y-6">
          <Panel>
            <PanelTitle>Upcoming appointments</PanelTitle>
            {upcoming.length ? (
              upcoming.map((a) => (
                <div
                  key={a.id}
                  className="mb-3 rounded-xl border border-success-border bg-success-soft p-4 last:mb-0"
                >
                  <div className="flex flex-wrap justify-between gap-3">
                    <div>
                      <p className="font-semibold">{a.service}</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {displayDate(a.start_time)} · {displayTime(a.start_time)} ·{" "}
                        {durationLabel(a.start_time, a.end_time)}
                      </p>
                      <p className="mt-1 text-sm">
                        {staffList.find((s) => s.id === a.staff_id)?.name ?? "Unassigned"}
                      </p>
                    </div>
                    <StatusBadge status={a.status} />
                  </div>
                </div>
              ))
            ) : (
              <Empty>No upcoming appointments.</Empty>
            )}
          </Panel>
          <Panel>
            <PanelTitle>Appointment history</PanelTitle>
            {history.length ? (
              history.map((a) => (
                <DataRow key={a.id}>
                  <div>
                    <p className="font-medium">{a.service}</p>
                    <p className="text-xs text-muted-foreground">{displayDate(a.start_time)}</p>
                  </div>
                  <span className="text-sm">
                    {staffList.find((s) => s.id === a.staff_id)?.name ?? "Unassigned"}
                  </span>
                  <StatusBadge status={a.status} />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Open notes for ${a.service}`}
                    onClick={() =>
                      toast.info(a.notes ? a.notes : "No notes recorded for this visit.")
                    }
                  >
                    <FileText />
                  </Button>
                </DataRow>
              ))
            ) : (
              <Empty>No past appointments.</Empty>
            )}
          </Panel>
          <Panel>
            <PanelTitle>Call history</PanelTitle>
            {calls.length ? (
              calls.map((x) => (
                <Link
                  key={x.id}
                  to="/conversations/$id"
                  params={{ id: x.id }}
                  className="block border-b border-border py-4 last:border-0"
                >
                  <div className="flex flex-wrap justify-between gap-2">
                    <div>
                      <p className="font-medium">{x.title}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {displayDate(x.started_at)} · {formatDuration(x.duration_seconds)}
                      </p>
                    </div>
                    <StatusBadge status={x.status} />
                  </div>
                  <p className="mt-2 break-words [overflow-wrap:anywhere] text-sm text-muted-foreground">
                    {dash(x.summary)}
                  </p>
                </Link>
              ))
            ) : (
              <Empty>No calls recorded.</Empty>
            )}
          </Panel>
        </div>
        <div className="space-y-6">
          <Panel>
            <PanelTitle>Contact information</PanelTitle>
            <dl className="space-y-4 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Phone number</dt>
                <dd className="mt-1">
                  <a className="break-all hover:underline" href={`tel:${c.phone}`}>
                    {c.phone}
                  </a>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Email address</dt>
                <dd className="mt-1 break-all">{dash(c.email)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Client since</dt>
                <dd className="mt-1">{displayDate(c.created_at)}</dd>
              </div>
            </dl>
          </Panel>
          <Panel>
            <PanelTitle>Internal notes</PanelTitle>
            <div className="space-y-3">
              {c.notes && (
                <div className="break-words [overflow-wrap:anywhere] rounded-xl bg-muted p-3 text-sm">
                  {c.notes}
                </div>
              )}
              {notes.map((n) => (
                <div
                  key={n.id}
                  className="break-words [overflow-wrap:anywhere] rounded-xl bg-muted p-3 text-sm"
                >
                  {n.note}
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {displayDate(n.created_at)}
                  </p>
                </div>
              ))}
              {!c.notes && !notes.length && <Empty>No notes yet.</Empty>}
            </div>
            <Textarea
              aria-label="Internal note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="mt-4"
              placeholder="Add an internal note"
            />
            <Button
              className="mt-3 w-full"
              disabled={!note.trim() || addNote.isPending}
              onClick={async () => {
                try {
                  await addNote.mutateAsync({ clientId: c.id, note });
                  setNote("");
                  toast.success("Note saved");
                } catch {
                  toast.error("Could not save the note.");
                }
              }}
            >
              {addNote.isPending ? "Saving…" : "Save note"}
            </Button>
          </Panel>
        </div>
      </div>
      <EditClientDialog client={editing} onClose={() => setEditing(null)} />
    </>
  );
}

// ------------------------------------------------------------------ staff
function AddStaffDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const addStaff = useAddStaff();
  const [schedule, setSchedule] = useState(() => buildWeeklyRows([]));
  const [name, setName] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [services, setServices] = useState("");
  const [error, setError] = useState("");
  const submit = async () => {
    if (!name.trim() || !specialty.trim()) {
      setError("Full name and specialty / role are required.");
      return;
    }
    if (!services.trim()) {
      setError("Add at least one service.");
      return;
    }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    try {
      const selectedHours = schedulePayload(schedule);
      await addStaff.mutateAsync({
        name,
        specialty,
        phone,
        email,
        services,
        schedule: selectedHours,
      });
      setError("");
      setName("");
      setSpecialty("");
      setPhone("");
      setEmail("");
      setServices("");
      setSchedule(buildWeeklyRows([]));
      onOpenChange(false);
      toast.success("Staff member added successfully");
    } catch (issue) {
      setError(
        issue instanceof Error &&
          [
            "Choose a valid seven-day schedule.",
            "Set start and end times for each working day.",
            "End time must be after start time for each day with hours.",
          ].includes(issue.message)
          ? issue.message
          : "Could not save the staff member. Please try again.",
      );
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!addStaff.isPending) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto rounded-2xl">
        <DialogHeader>
          <DialogTitle>Add staff member</DialogTitle>
          <DialogDescription>
            Add a team member and choose working days. Days left off have no availability.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <div className="rounded-[10px] border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
        <div className="grid gap-4">
          <div>
            <Label htmlFor="staff-name">Full name</Label>
            <Input
              id="staff-name"
              className={cn(field, "mt-2")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Practitioner full name"
            />
          </div>
          <div>
            <Label htmlFor="staff-specialty">Specialty / role</Label>
            <Input
              id="staff-specialty"
              className={cn(field, "mt-2")}
              value={specialty}
              onChange={(e) => setSpecialty(e.target.value)}
              placeholder="Orthodontics"
            />
          </div>
          <div>
            <Label htmlFor="staff-phone">
              Phone number <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="staff-phone"
              type="tel"
              inputMode="tel"
              className={cn(field, "mt-2")}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+965 2225 4104"
            />
          </div>
          <div>
            <Label htmlFor="staff-email">
              Email address <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="staff-email"
              type="email"
              inputMode="email"
              className={cn(field, "mt-2")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@clinic.com"
            />
          </div>
          <div>
            <Label htmlFor="staff-services">Services</Label>
            <Input
              id="staff-services"
              className={cn(field, "mt-2")}
              value={services}
              onChange={(e) => setServices(e.target.value)}
              placeholder="Dental Cleaning, Consultation"
            />
            <p className="mt-1 text-xs text-muted-foreground">Separate services with commas.</p>
          </div>
          <div>
            <Label>Working days and hours</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              Select a day to set its hours. No days are selected by default.
            </p>
            <div className="mt-3 space-y-2">
              {schedule.map((row) => (
                <div
                  key={row.day_of_week}
                  className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-[110px_1fr_1fr] sm:items-center"
                >
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      checked={row.is_available}
                      onChange={(event) =>
                        setSchedule((previous) =>
                          previous.map((item) =>
                            item.day_of_week === row.day_of_week
                              ? { ...item, is_available: event.target.checked }
                              : item,
                          ),
                        )
                      }
                    />
                    {DAY_NAMES[row.day_of_week]}
                  </label>
                  <Input
                    type="time"
                    aria-label={`${DAY_NAMES[row.day_of_week]} start time`}
                    value={row.start_time}
                    disabled={!row.is_available}
                    onChange={(event) =>
                      setSchedule((previous) =>
                        previous.map((item) =>
                          item.day_of_week === row.day_of_week
                            ? { ...item, start_time: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                  <Input
                    type="time"
                    aria-label={`${DAY_NAMES[row.day_of_week]} end time`}
                    value={row.end_time}
                    disabled={!row.is_available}
                    onChange={(event) =>
                      setSchedule((previous) =>
                        previous.map((item) =>
                          item.day_of_week === row.day_of_week
                            ? { ...item, end_time: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={addStaff.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button disabled={addStaff.isPending} onClick={() => void submit()}>
            {addStaff.isPending ? "Saving…" : "Add staff member"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditStaffDialog({ member, onClose }: { member: StaffMember | null; onClose: () => void }) {
  const updateStaff = useUpdateStaff();
  const [name, setName] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [services, setServices] = useState("");
  useEffect(() => {
    if (member) {
      setName(member.full_name);
      setSpecialty(member.specialty);
      setPhone(member.phone ?? "");
      setEmail(member.email ?? "");
      setServices(member.services.join(", "));
    }
  }, [member]);
  if (!member) return null;
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !updateStaff.isPending) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto rounded-2xl">
        <DialogHeader>
          <DialogTitle>Edit staff member</DialogTitle>
          <DialogDescription>Update {member.name}'s details and services.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div>
            <Label htmlFor="edit-staff-name">Full name</Label>
            <Input
              id="edit-staff-name"
              className={cn(field, "mt-2")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="edit-staff-specialty">Specialty / role</Label>
            <Input
              id="edit-staff-specialty"
              className={cn(field, "mt-2")}
              value={specialty}
              onChange={(e) => setSpecialty(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="edit-staff-phone">Phone number</Label>
            <Input
              id="edit-staff-phone"
              className={cn(field, "mt-2")}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="edit-staff-email">Email address</Label>
            <Input
              id="edit-staff-email"
              className={cn(field, "mt-2")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="edit-staff-services">Services</Label>
            <Input
              id="edit-staff-services"
              className={cn(field, "mt-2")}
              value={services}
              onChange={(e) => setServices(e.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">Separate services with commas.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={updateStaff.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={updateStaff.isPending}
            onClick={async () => {
              if (!name.trim() || !specialty.trim()) {
                toast.error("Full name and specialty are required.");
                return;
              }
              try {
                await updateStaff.mutateAsync({
                  id: member.id,
                  full_name: name.trim(),
                  specialty: specialty.trim(),
                  phone: phone.trim() || null,
                  email: email.trim() || null,
                  services: services
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                });
                toast.success("Staff member updated");
                onClose();
              } catch {
                toast.error("Could not update the staff member.");
              }
            }}
          >
            {updateStaff.isPending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function StaffPage() {
  const staffList = useStaff();
  const { role } = useAuth();
  const dataStatus = useDataStatus(["staff"]);
  const [q, setQ] = useState("");
  const [specialty, setSpecialty] = useState("all");
  const [open, setOpen] = useState(false);
  const specialties = [...new Set(staffList.map((s) => s.specialty))];
  const rows = staffList.filter(
    (s) =>
      `${s.name} ${s.specialty} ${s.services.join(" ")}`.toLowerCase().includes(q.toLowerCase()) &&
      (specialty === "all" || s.specialty === specialty),
  );
  const groups = [...new Set(rows.map((s) => s.specialty))];
  if (dataStatus) return dataStatus;
  return (
    <>
      <PageHeader
        title="Staff"
        description="Manage your clinic team, hours, and assigned services."
        action={
          hasPermission(role, "staff.manage") ? (
            <Button onClick={() => setOpen(true)}>
              <Plus />
              Add staff member
            </Button>
          ) : undefined
        }
      />
      <div className="mb-6 flex flex-col gap-3 sm:flex-row">
        <div className="flex-1 sm:max-w-md">
          <SearchBox value={q} onChange={setQ} placeholder="Search staff or services" />
        </div>
        <Select value={specialty} onValueChange={setSpecialty}>
          <SelectTrigger className="w-full sm:w-[220px]">
            <Filter />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All specialties</SelectItem>
            {specialties.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {groups.length ? (
        groups.map((g) => (
          <section key={g} className="mb-7">
            <h2 className="mb-3 text-sm font-semibold text-muted-foreground">{g}</h2>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {rows
                .filter((s) => s.specialty === g)
                .map((s) => (
                  <Link key={s.id} to="/staff/$id" params={{ id: s.id }}>
                    <Panel className="h-full transition-shadow hover:shadow-modal">
                      <div className="flex items-center gap-4">
                        <Avatar initials={s.initials} large />
                        <div className="min-w-0 break-words">
                          <h3 className="font-semibold">{s.name}</h3>
                          <p className="text-sm text-muted-foreground">{s.specialty}</p>
                          <div className="mt-2">
                            <StatusBadge status={s.active ? "Active" : "Inactive"} />
                          </div>
                        </div>
                      </div>
                      <div className="mt-5 border-t border-border pt-4 text-xs text-muted-foreground">
                        {s.services.length} services
                      </div>
                    </Panel>
                  </Link>
                ))}
            </div>
          </section>
        ))
      ) : (
        <Empty>{staffList.length ? "No staff match your search." : "No staff yet."}</Empty>
      )}
      <AddStaffDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function StaffTimeOffEditor({
  staffId,
  block,
  timeZone,
  onClose,
}: {
  staffId: string;
  block: StaffTimeOffRow | "new" | null;
  timeZone: string;
  onClose: () => void;
}) {
  const save = useSaveTimeOff();
  const remove = useRemoveTimeOff();
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    setStart(block && block !== "new" ? toClinicInput(block.start_time, timeZone) : "");
    setEnd(block && block !== "new" ? toClinicInput(block.end_time, timeZone) : "");
    setReason(block && block !== "new" ? (block.reason ?? "") : "");
    setError("");
  }, [block, timeZone]);
  if (!block) return null;
  const existing = block === "new" ? null : block;
  const submit = async () => {
    try {
      const startTime = fromClinicInput(start, timeZone);
      const endTime = fromClinicInput(end, timeZone);
      if (new Date(endTime) <= new Date(startTime)) {
        setError("End time must be after start time.");
        return;
      }
      await save.mutateAsync({
        ...(existing ? { id: existing.id } : {}),
        staffId,
        startTime,
        endTime,
        reason,
      });
      toast.success("Time off saved");
      onClose();
    } catch {
      setError("Could not save time off. Please try again.");
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending && !remove.isPending) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto rounded-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit time off" : "Add time off"}</DialogTitle>
          <DialogDescription>
            Blocked time for this practitioner. Times are in {timeZone}.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="grid gap-4">
          <div>
            <Label htmlFor="time-off-start">Starts</Label>
            <Input
              id="time-off-start"
              type="datetime-local"
              className="mt-2"
              value={start}
              onChange={(event) => setStart(event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="time-off-end">Ends</Label>
            <Input
              id="time-off-end"
              type="datetime-local"
              className="mt-2"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="time-off-reason">Reason (optional)</Label>
            <Input
              id="time-off-reason"
              className="mt-2"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          {existing && (
            <Button
              variant="destructive"
              disabled={remove.isPending || save.isPending}
              onClick={async () => {
                if (!window.confirm("Remove this time off?")) return;
                try {
                  await remove.mutateAsync({ id: existing.id, staffId });
                  toast.success("Time off removed");
                  onClose();
                } catch {
                  setError("Could not remove time off.");
                }
              }}
            >
              Remove
            </Button>
          )}
          <Button variant="outline" disabled={save.isPending || remove.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={save.isPending || remove.isPending} onClick={() => void submit()}>
            {save.isPending ? "Saving…" : "Save time off"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function StaffDetailPage({ id }: { id: string }) {
  const staffList = useStaff();
  const appointments = useAppointments();
  const clients = useClients();
  const availabilityQuery = useAvailability(id);
  const availability = availabilityQuery.data ?? EMPTY_AVAILABILITY;
  const timeOffQuery = useTimeOff(id);
  const saveAvailability = useSaveAvailability();
  const { role, clinic } = useAuth();
  const canManage = hasPermission(role, "staff.manage");
  const dataStatus = useDataStatus(["staff", "appointments", "clients"]);
  const [editing, setEditing] = useState(false);
  const [editDetails, setEditDetails] = useState<StaffMember | null>(null);
  const [timeOffEditor, setTimeOffEditor] = useState<StaffTimeOffRow | "new" | null>(null);
  const [rows, setRows] = useState<
    { day_of_week: number; start_time: string; end_time: string; is_available: boolean }[]
  >([]);
  useEffect(() => {
    if (editing) return;
    setRows(buildWeeklyRows(availability));
  }, [availability, editing]);
  const s = staffList.find((x) => x.id === id);
  if (dataStatus) return dataStatus;
  if (availabilityQuery.isPending || timeOffQuery.isPending)
    return (
      <Panel>
        <p className="text-sm text-muted-foreground" role="status">
          Loading schedule…
        </p>
      </Panel>
    );
  if (availabilityQuery.isError || timeOffQuery.isError)
    return (
      <Panel>
        <Empty>
          Could not load this schedule.{" "}
          <Button
            variant="outline"
            size="sm"
            className="ml-2"
            onClick={() => {
              void availabilityQuery.refetch();
              void timeOffQuery.refetch();
            }}
          >
            Try again
          </Button>
        </Empty>
      </Panel>
    );
  if (!s)
    return (
      <>
        <Link
          to="/staff"
          className="mb-5 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to Staff
        </Link>
        <Empty>This team member could not be found.</Empty>
      </>
    );
  const setRow = (
    day: number,
    patch: Partial<{ start_time: string; end_time: string; is_available: boolean }>,
  ) => setRows((prev) => prev.map((r) => (r.day_of_week === day ? { ...r, ...patch } : r)));
  const upcoming = appointments.filter((a) => a.staff_id === s.id && isUpcomingAppointment(a));
  const displayDate = (iso: string) => formatDate(iso, clinic?.timezone);
  const displayTime = (iso: string) => formatTime(iso, clinic?.timezone);
  return (
    <>
      <Link
        to="/staff"
        className="mb-5 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to Staff
      </Link>
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <Avatar initials={s.initials} large />
        <div className="mr-auto min-w-0">
          <h1 className="break-words text-2xl font-semibold">{s.name}</h1>
          <p className="text-sm text-muted-foreground">{s.specialty}</p>
        </div>
        {canManage && (
          <>
            <Button variant="ghost" onClick={() => setEditDetails(s)}>
              Edit details
            </Button>
            <Button variant="outline" onClick={() => setEditing(true)}>
              Manage availability
            </Button>
          </>
        )}
      </div>
      <div className="grid gap-6 xl:grid-cols-[1.2fr_.8fr]">
        <Panel>
          <PanelTitle
            detail={
              canManage && editing ? (
                <Button
                  size="sm"
                  disabled={saveAvailability.isPending}
                  onClick={async () => {
                    if (
                      rows.some(
                        (r) =>
                          r.is_available &&
                          (!r.start_time || !r.end_time || r.end_time <= r.start_time),
                      )
                    ) {
                      toast.error("Set valid start and end times for each working day.");
                      return;
                    }
                    if (rows.every((r) => !r.start_time && !r.end_time && !r.is_available)) {
                      toast.info("No hours to save.");
                      setEditing(false);
                      return;
                    }
                    try {
                      await saveAvailability.mutateAsync({ staffId: s.id, rows });
                      setEditing(false);
                      toast.success("Schedule saved and verified");
                    } catch {
                      toast.error("Could not save the schedule. Please try again.");
                    }
                  }}
                >
                  Save hours
                </Button>
              ) : null
            }
          >
            Weekly schedule
          </PanelTitle>
          {rows.map((r) => (
            <div
              key={r.day_of_week}
              className="flex flex-wrap items-center gap-2 border-b border-border py-3 last:border-0 sm:gap-3"
            >
              <span className="w-full text-sm font-medium sm:w-[100px]">
                {DAY_NAMES[r.day_of_week]}
              </span>
              <Input
                type="time"
                aria-label={`${DAY_NAMES[r.day_of_week]} start time`}
                className="min-w-0 flex-1 basis-[110px]"
                value={r.start_time}
                disabled={!editing || !canManage}
                onChange={(e) => setRow(r.day_of_week, { start_time: e.target.value })}
              />
              <Input
                type="time"
                aria-label={`${DAY_NAMES[r.day_of_week]} end time`}
                className="min-w-0 flex-1 basis-[110px]"
                value={r.end_time}
                disabled={!editing || !canManage}
                onChange={(e) => setRow(r.day_of_week, { end_time: e.target.value })}
              />
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={r.is_available}
                  disabled={!editing || !canManage}
                  onChange={(e) => setRow(r.day_of_week, { is_available: e.target.checked })}
                />{" "}
                Working
              </label>
            </div>
          ))}
          <p className="mt-3 text-xs text-muted-foreground">
            Working days:{" "}
            {rows
              .filter((r) => r.is_available)
              .map((r) => DAY_NAMES[r.day_of_week]?.slice(0, 3))
              .join(", ") || "None set"}
          </p>
        </Panel>
        <div className="space-y-6">
          <Panel>
            <PanelTitle>Contact details</PanelTitle>
            <p className="break-all text-sm">{dash(s.email)}</p>
            <p className="mt-2 break-all text-sm">{dash(s.phone)}</p>
          </Panel>
          <Panel>
            <PanelTitle
              detail={
                canManage ? (
                  <Button size="sm" variant="ghost" onClick={() => setEditDetails(s)}>
                    Edit
                  </Button>
                ) : null
              }
            >
              Assigned services
            </PanelTitle>
            {s.services.length ? (
              <div className="flex flex-wrap gap-2">
                {s.services.map((x) => (
                  <span
                    className="rounded-full border border-border bg-muted px-3 py-1 text-xs"
                    key={x}
                  >
                    {x}
                  </span>
                ))}
              </div>
            ) : (
              <Empty>No services assigned yet.</Empty>
            )}
          </Panel>
          <Panel>
            <PanelTitle
              detail={
                canManage ? (
                  <Button size="sm" variant="outline" onClick={() => setTimeOffEditor("new")}>
                    Add time off
                  </Button>
                ) : null
              }
            >
              Time off
            </PanelTitle>
            {timeOffQuery.data?.length ? (
              timeOffQuery.data.map((block) => (
                <div
                  key={block.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-0"
                >
                  <div className="text-sm">
                    <p className="break-words font-medium">
                      {displayDate(block.start_time)} at {displayTime(block.start_time)} –{" "}
                      {displayDate(block.end_time)} at {displayTime(block.end_time)}
                    </p>
                    {block.reason && (
                      <p className="mt-1 text-xs text-muted-foreground">{block.reason}</p>
                    )}
                  </div>
                  {canManage && (
                    <Button size="sm" variant="ghost" onClick={() => setTimeOffEditor(block)}>
                      Edit
                    </Button>
                  )}
                </div>
              ))
            ) : (
              <Empty>No time off recorded.</Empty>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Times shown in {clinic?.timezone ?? "UTC"}.
            </p>
          </Panel>
          <Panel>
            <PanelTitle>Upcoming appointments</PanelTitle>
            {upcoming.length ? (
              upcoming.map((a) => (
                <div key={a.id} className="border-b border-border py-3 last:border-0">
                  <p className="text-sm font-medium">
                    {clients.find((c) => c.id === a.client_id)?.name ?? "Unknown client"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {displayDate(a.start_time)} · {displayTime(a.start_time)} · {a.service}
                  </p>
                </div>
              ))
            ) : (
              <Empty>No upcoming appointments.</Empty>
            )}
          </Panel>
        </div>
      </div>
      <EditStaffDialog member={editDetails} onClose={() => setEditDetails(null)} />
      <StaffTimeOffEditor
        staffId={s.id}
        block={timeOffEditor}
        timeZone={clinic?.timezone ?? "UTC"}
        onClose={() => setTimeOffEditor(null)}
      />
    </>
  );
}

// ---------------------------------------------------------- conversations
export function ConversationsPage() {
  const { clinic } = useAuth();
  const conversations = useConversations();
  const clients = useClients();
  const dataStatus = useDataStatus(["conversations", "clients"]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const clientOf = (c: ConversationRow) => clients.find((x) => x.id === c.client_id);
  const rows = conversations.filter((c) => {
    const cl = clientOf(c);
    return (
      `${cl?.name ?? ""} ${c.caller_phone ?? ""} ${c.title}`
        .toLowerCase()
        .includes(q.toLowerCase()) &&
      (status === "all" || c.status === status)
    );
  });
  if (dataStatus) return dataStatus;
  const displayDate = (iso: string) => formatDate(iso, clinic?.timezone);
  const displayTime = (iso: string) => formatTime(iso, clinic?.timezone);
  return (
    <>
      <PageHeader title="Conversations" description="Review every call answered for your clinic." />
      <Panel>
        <div className="mb-5 flex flex-col gap-3 sm:flex-row">
          <div className="flex-1">
            <SearchBox value={q} onChange={setQ} placeholder="Search caller or reason" />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="Booked">Booked</SelectItem>
              <SelectItem value="Completed">Completed</SelectItem>
              <SelectItem value="Needs Review">Needs Review</SelectItem>
              <SelectItem value="Missed">Missed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {rows.length ? (
          rows.map((c) => {
            const cl = clientOf(c);
            return (
              <DataRow key={c.id}>
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar initials={cl?.initials ?? "?"} />
                  <div className="min-w-0">
                    <Link
                      to="/conversations/$id"
                      params={{ id: c.id }}
                      className="font-semibold hover:underline"
                    >
                      {c.title}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {cl?.name ?? "Unknown caller"} · {dash(c.caller_phone)}
                    </p>
                  </div>
                </div>
                <span className="text-sm text-muted-foreground">
                  {displayDate(c.started_at)}
                  <br />
                  {displayTime(c.started_at)}
                </span>
                <span className="text-sm tabular-nums">{formatDuration(c.duration_seconds)}</span>
                <StatusBadge status={c.status} />
              </DataRow>
            );
          })
        ) : (
          <Empty>
            {conversations.length
              ? "No conversations match these filters."
              : "No conversations yet."}
          </Empty>
        )}
      </Panel>
    </>
  );
}

export function ConversationDetailPage({ id }: { id: string }) {
  const { clinic } = useAuth();
  const conversations = useConversations();
  const clients = useClients();
  const appointments = useAppointments();
  const staffList = useStaff();
  const dataStatus = useDataStatus(["conversations", "clients", "appointments", "staff"]);
  const c = conversations.find((x) => x.id === id);
  if (dataStatus) return dataStatus;
  if (!c)
    return (
      <>
        <Link
          to="/conversations"
          className="mb-5 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to Conversations
        </Link>
        <Empty>This conversation could not be found.</Empty>
      </>
    );
  const client = clients.find((x) => x.id === c.client_id);
  const appt = appointments.find((a) => a.id === c.appointment_id);
  const turns = parseTranscript(c.transcript);
  const displayDate = (iso: string) => formatDate(iso, clinic?.timezone);
  const displayTime = (iso: string) => formatTime(iso, clinic?.timezone);
  return (
    <>
      <Link
        to="/conversations"
        className="mb-5 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to Conversations
      </Link>
      <PageHeader
        title={c.title}
        description={`${displayDate(c.started_at)} at ${displayTime(c.started_at)}`}
        action={<StatusBadge status={c.status} />}
      />
      <div className="grid gap-6 xl:grid-cols-[1.4fr_.6fr]">
        <div className="space-y-6">
          <Panel>
            <PanelTitle
              detail={
                <span className="text-[10px] font-semibold uppercase text-success">
                  Apero summary
                </span>
              }
            >
              Conversation summary
            </PanelTitle>
            <p className="break-words [overflow-wrap:anywhere] text-sm leading-6">
              {dash(c.summary)}
            </p>
            <div className="mt-5 grid grid-cols-2 gap-3 rounded-xl bg-muted p-3 text-xs sm:grid-cols-4">
              <div>
                <span className="text-muted-foreground">Date</span>
                <b className="mt-1 block">{displayDate(c.started_at)}</b>
              </div>
              <div>
                <span className="text-muted-foreground">Time</span>
                <b className="mt-1 block">{displayTime(c.started_at)}</b>
              </div>
              <div>
                <span className="text-muted-foreground">Duration</span>
                <b className="mt-1 block">{formatDuration(c.duration_seconds)}</b>
              </div>
              <div>
                <span className="text-muted-foreground">Channel</span>
                <b className="mt-1 block text-success">Voice call</b>
              </div>
            </div>
          </Panel>
          <Panel>
            <PanelTitle>Call recording</PanelTitle>
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-nav-active p-4 sm:gap-4">
              <RecordingPlayer conversationId={c.id} />
              <span className="text-xs tabular-nums">{formatDuration(c.duration_seconds)}</span>
            </div>
          </Panel>
          <Panel>
            <PanelTitle
              detail={<span className="text-xs text-muted-foreground">{turns.length} turns</span>}
            >
              Full transcript
            </PanelTitle>
            {turns.length ? (
              <div className="space-y-5">
                {turns.map((turn, i) => {
                  const apero = turn.speaker === "Apero Receptionist" || turn.speaker === "Apero";
                  return (
                    <div key={i} className={cn("flex gap-2", !apero && "justify-end")}>
                      <div
                        className={cn("min-w-0 max-w-[90%] sm:max-w-[82%]", !apero && "text-right")}
                      >
                        <p className="mb-1 text-[10px] text-muted-foreground">
                          <b className="text-foreground">{turn.speaker}</b> · {turn.time}
                        </p>
                        <p
                          className={cn(
                            "break-words [overflow-wrap:anywhere] rounded-xl px-3 py-2 text-left text-sm",
                            apero ? "bg-nav-active" : "bg-primary text-primary-foreground",
                          )}
                        >
                          {turn.text}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Empty>No transcript is available for this call.</Empty>
            )}
          </Panel>
        </div>
        <div className="space-y-6">
          <Panel>
            <PanelTitle detail={<StatusBadge status={c.status} />}>
              Extracted information
            </PanelTitle>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Client</dt>
                <dd className="min-w-0 break-words text-right font-medium">
                  {client?.name ?? "Unknown"}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Phone</dt>
                <dd className="min-w-0 break-all text-right">
                  {dash(c.caller_phone ?? client?.phone)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Outcome</dt>
                <dd className="min-w-0 break-words text-right">{dash(c.outcome)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Practitioner</dt>
                <dd>{appt ? (staffList.find((s) => s.id === appt.staff_id)?.name ?? "—") : "—"}</dd>
              </div>
            </dl>
          </Panel>
          {client && (
            <Panel>
              <PanelTitle>Client profile</PanelTitle>
              <div className="flex items-center gap-3">
                <Avatar initials={client.initials} />
                <div>
                  <p className="break-words font-semibold">{client.name}</p>
                  <p className="break-all text-xs text-muted-foreground">{client.phone}</p>
                </div>
              </div>
              <Button variant="outline" className="mt-5 w-full" asChild>
                <Link to="/clients/$id" params={{ id: client.id }}>
                  View full profile
                </Link>
              </Button>
            </Panel>
          )}
          {appt && (
            <Panel>
              <PanelTitle>Related appointment</PanelTitle>
              <p className="font-medium">{appt.service}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {displayDate(appt.start_time)} · {displayTime(appt.start_time)}
              </p>
              <div className="mt-3">
                <StatusBadge status={appt.status} />
              </div>
              <Button variant="ghost" className="mt-4 w-full" asChild>
                <Link to="/calendar">Open calendar</Link>
              </Button>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- account
export function AccountPage() {
  const navigate = useNavigate();
  const { profile, clinic, clinicId, updatePassword, signOut, refreshProfile } = useAuth();
  const [logout, setLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [pw, setPw] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [updatingPassword, setUpdatingPassword] = useState(false);
  useEffect(() => {
    if (profile) {
      setName(profile.full_name);
      setPhone(profile.phone ?? "");
    }
  }, [profile]);
  const rules = [pw.length >= 8, /[A-Z]/.test(pw), /\d/.test(pw)];
  const saveProfile = async () => {
    if (!profile || !clinicId || !name.trim()) {
      toast.error("Enter your name.");
      return;
    }
    setSaving(true);
    try {
      const { db } = await import("@/lib/db");
      const values = { full_name: name.trim(), phone: phone.trim() || null };
      const { data, error } = await db
        .from("profiles")
        .update(values)
        .eq("id", profile.id)
        .eq("clinic_id", clinicId)
        .select("full_name,phone")
        .single();
      if (error || data?.full_name !== values.full_name || data?.phone !== values.phone) {
        toast.error("Could not save your changes.");
        return;
      }
      const { data: saved, error: readError } = await db
        .from("profiles")
        .select("full_name,phone")
        .eq("id", profile.id)
        .eq("clinic_id", clinicId)
        .single();
      if (readError || saved?.full_name !== values.full_name || saved?.phone !== values.phone) {
        toast.error("Could not verify your changes.");
        return;
      }
      await refreshProfile(true);
      toast.success("Changes saved");
    } catch {
      toast.error("Could not save your changes.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <PageHeader title="Account" description="Manage your profile and account security." />
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel>
          <PanelTitle>Personal information</PanelTitle>
          <div className="grid gap-4">
            <div>
              <Label htmlFor="profile-name">Full name</Label>
              <Input
                id="profile-name"
                className="mt-2"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="profile-email">Email address</Label>
              <Input
                id="profile-email"
                type="email"
                className="mt-2"
                value={profile?.email ?? ""}
                readOnly
              />
            </div>
            <div>
              <Label htmlFor="profile-phone">Phone number</Label>
              <Input
                id="profile-phone"
                type="tel"
                inputMode="tel"
                className="mt-2"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
            <div className="grid gap-3 rounded-xl bg-muted p-3 text-sm sm:grid-cols-2">
              <div>
                <span className="text-muted-foreground">Clinic</span>
                <p className="break-words [overflow-wrap:anywhere] font-medium">
                  {clinic?.name ?? "Unavailable"}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Role</span>
                <p className="font-medium capitalize">
                  {profile ? ROLE_LABELS[profile.role] : "Unavailable"}
                </p>
              </div>
            </div>
            <Button
              className="justify-self-end"
              disabled={saving}
              onClick={() => void saveProfile()}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </Panel>
        <AccountAccessPanel />
        <Panel>
          <PanelTitle>Password</PanelTitle>
          <div className="grid gap-4">
            <div>
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                className="mt-2"
                type="password"
                autoComplete="new-password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
              />
            </div>
            <div className="space-y-2 rounded-xl bg-muted p-3 text-xs">
              {["At least 8 characters", "At least 1 uppercase letter", "At least 1 number"].map(
                (r, i) => (
                  <div
                    key={r}
                    className={cn(
                      "flex items-center gap-2",
                      rules[i] ? "text-success-strong" : "text-muted-foreground",
                    )}
                  >
                    <CheckCircle2 className="size-3" />
                    {r}
                  </div>
                ),
              )}
            </div>
            <Button
              disabled={!rules.every(Boolean) || updatingPassword}
              onClick={async () => {
                setUpdatingPassword(true);
                try {
                  const { error } = await updatePassword(pw);
                  if (error) {
                    toast.error("Could not update the password.");
                    return;
                  }
                  setPw("");
                  toast.success("Password updated");
                } catch {
                  toast.error("Could not update the password.");
                } finally {
                  setUpdatingPassword(false);
                }
              }}
            >
              {updatingPassword ? "Updating…" : "Update password"}
            </Button>
          </div>
        </Panel>
        <Panel>
          <PanelTitle>Need help?</PanelTitle>
          <p className="text-sm text-muted-foreground">
            Contact Apero Support for help with your account or clinic workspace.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button variant="outline" asChild>
              <Link to="/support">
                <Mail />
                Contact Support
              </Link>
            </Button>
            {hasPermission(profile?.role ?? null, "clinic.configure") && (
              <Button variant="outline" asChild>
                <Link to="/account/settings">
                  <Settings />
                  Settings
                </Link>
              </Button>
            )}
          </div>
          <div className="mt-5 flex gap-4 text-xs text-muted-foreground">
            <Link to="/privacy" className="underline">
              Privacy Policy
            </Link>
            <Link to="/terms" className="underline">
              Terms of Service
            </Link>
          </div>
        </Panel>
        <Panel>
          <PanelTitle>Log out</PanelTitle>
          <p className="text-sm text-muted-foreground">
            Sign out of your Apero account on this device.
          </p>
          <Button variant="destructive" className="mt-4" onClick={() => setLogout(true)}>
            Log out
          </Button>
        </Panel>
      </div>
      <Dialog
        open={logout}
        onOpenChange={(open) => {
          if (!loggingOut) setLogout(open);
        }}
      >
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>Log out?</DialogTitle>
            <DialogDescription>Are you sure you want to log out of Apero?</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={loggingOut} onClick={() => setLogout(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={loggingOut}
              onClick={async () => {
                if (loggingOut) return;
                setLoggingOut(true);
                try {
                  const { error } = await signOut();
                  if (error) {
                    toast.error("Could not log out. Please try again.");
                    return;
                  }
                  setLogout(false);
                  void navigate({ to: "/login" });
                } catch {
                  toast.error("Could not log out. Please try again.");
                } finally {
                  setLoggingOut(false);
                }
              }}
            >
              {loggingOut ? "Logging out…" : "Log out"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------- support
export function SupportPage() {
  const { profile } = useAuth();
  const clinicName = useClinicName();
  const email = "apero.hq@gmail.com";
  const subject = encodeURIComponent("Apero clinic support request");
  const body = encodeURIComponent(
    `Clinic: ${clinicName}\nAccount: ${profile?.email ?? ""}\n\nPlease describe the issue and when it happened:\n`,
  );
  return (
    <>
      <PageHeader title="Support" description="Help with your clinic workspace and account." />
      <div className="grid max-w-4xl gap-6 lg:grid-cols-[1.2fr_.8fr]">
        <Panel>
          <PanelTitle>Contact Apero Support</PanelTitle>
          <p className="text-sm leading-6 text-muted-foreground">
            Describe what happened and when. Your email app will open with your clinic and account
            details filled in. Please avoid including patient details unless needed to resolve the
            issue.
          </p>
          <Button className="mt-5" asChild>
            <a href={`mailto:${email}?subject=${subject}&body=${body}`}>
              <Mail />
              Email support
            </a>
          </Button>
          <p className="mt-4 break-all text-sm">
            <a href={`mailto:${email}`} className="underline">
              {email}
            </a>
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            This opens your email app; the message is sent only when you send it there.
          </p>
        </Panel>
        <Panel>
          <PanelTitle>Common help topics</PanelTitle>
          <div className="space-y-4 text-sm">
            <div>
              <p className="font-medium">Can’t sign in?</p>
              <p className="text-muted-foreground">
                Use Forgot password on the sign-in page, or email support if you no longer have
                access to that address.
              </p>
            </div>
            <div>
              <p className="font-medium">Incorrect booking or call details?</p>
              <p className="text-muted-foreground">
                Review the appointment or conversation in Apero and contact your clinic team for
                immediate operational changes.
              </p>
            </div>
            <div>
              <p className="font-medium">Urgent account or technical issue?</p>
              <p className="text-muted-foreground">
                Email support with “Urgent” in the subject. For time-sensitive patient needs, use
                your clinic’s direct contact and escalation process.
              </p>
            </div>
          </div>
        </Panel>
      </div>
      <div className="mt-6 flex gap-4 text-xs text-muted-foreground">
        <Link to="/privacy" className="underline">
          Privacy Policy
        </Link>
        <Link to="/terms" className="underline">
          Terms of Service
        </Link>
      </div>
    </>
  );
}
