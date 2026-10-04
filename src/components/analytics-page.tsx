import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { PageHeader, Panel, PanelTitle, Empty } from "./page-ui";
import { Button } from "./ui/button";
import { useAuth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import { analyticsRange, type Analytics } from "@/lib/analytics";

export function AnalyticsPage() {
  const { clinic, clinicId, profile, role } = useAuth();
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const allowed = hasPermission(role, "analytics.view");
  let range: { start: string; end: string } | null = null;
  try {
    if (clinic?.timezone) range = analyticsRange(days, clinic.timezone);
  } catch {
    // Invalid clinic configuration must not fall back to the browser or UTC.
  }
  const query = useQuery({
    queryKey: [
      "analytics",
      clinicId,
      profile?.id,
      role,
      clinic?.timezone,
      range?.start,
      range?.end,
    ],
    enabled: allowed && !!clinicId && !!range,
    retry: false,
    refetchInterval: 60_000,
    queryFn: async ({ signal }) => {
      if (!range) throw new Error("Clinic timezone is unavailable");
      const { data, error } = await db
        .rpc("clinic_analytics", {
          p_clinic_id: clinicId!,
          p_start_date: range.start,
          p_end_date: range.end,
        })
        .abortSignal(signal);
      if (error) throw error;
      return data as unknown as Analytics;
    },
  });
  if (!allowed) return <Empty>This section isn’t available for your role.</Empty>;
  if (!range)
    return (
      <Panel>
        <p role="alert">
          Analytics needs a valid clinic timezone. Ask the clinic Owner to check Settings.
        </p>
      </Panel>
    );
  const data = query.data;
  return (
    <>
      <PageHeader
        title="Analytics"
        description="Calls and appointments in your clinic records."
        action={
          <label className="flex items-center gap-2 text-sm">
            Date range
            <select
              className="rounded-lg border border-border bg-card p-2"
              value={days}
              onChange={(e) => setDays(Number(e.target.value) as 7 | 30 | 90)}
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </label>
        }
      />
      <p className="mb-4 text-sm text-muted-foreground">
        {data?.startDate ?? range.start} – {data?.endDate ?? range.end} ·{" "}
        {data?.timezone ?? clinic?.timezone ?? "UTC"} · Includes today
      </p>
      {query.isPending ? (
        <Panel>
          <p role="status">Loading analytics…</p>
        </Panel>
      ) : query.isError || !data ? (
        <Panel>
          <p role="alert">
            Could not load analytics. Access may have changed. Try again or sign in again.
          </p>
          <Button className="mt-3" variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </Panel>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["Total calls", data.totalCalls, "Recorded calls, all statuses"],
              [
                "Total appointments",
                data.totalAppointments,
                "Scheduled in this range, all statuses",
              ],
              ["Booked appointments", data.bookedAppointments, "Current status: Booked"],
              ["Cancelled appointments", data.cancelledAppointments, "Current status: Cancelled"],
            ].map(([label, value, note]) => (
              <Panel key={label}>
                <p className="text-sm text-muted-foreground">{label}</p>
                <p className="my-2 text-3xl font-semibold tabular-nums">
                  {Number(value).toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">{note}</p>
              </Panel>
            ))}
          </div>
          {data.otherAppointments > 0 && (
            <p className="mt-3 text-sm text-muted-foreground">
              Total includes {data.otherAppointments} appointments with other recorded statuses.
            </p>
          )}
          {!data.totalCalls && !data.totalAppointments && (
            <div className="mt-6">
              <Empty>
                No calls or appointments in this date range. Choose a wider range to check older
                records.
              </Empty>
            </div>
          )}
          <div className="mt-6 grid gap-6 xl:grid-cols-2">
            <Trend data={data} field="calls" title="Daily calls" />
            <Trend data={data} field="appointments" title="Daily appointments" />
            <Breakdown
              title="Appointments by practitioner"
              rows={data.practitioners}
              other={data.otherPractitionerAppointments}
            />
            <Breakdown
              title="Appointments by service"
              rows={data.services}
              other={data.otherServiceAppointments}
            />
          </div>
          <Panel className="mt-6">
            <PanelTitle>How to read these numbers</PanelTitle>
            <p className="text-sm text-muted-foreground">
              Calls use their recorded start time. Appointments use their scheduled start time,
              including cancelled appointments. Booked and cancelled counts reflect current status;
              they are not counts of booking or cancellation events. Breakdowns include all
              appointment statuses and show up to 20 groups, with the remainder combined. Daily
              dates follow the clinic timezone.
            </p>
          </Panel>
        </>
      )}
    </>
  );
}

function Trend({
  data,
  field,
  title,
}: {
  data: Analytics;
  field: "calls" | "appointments";
  title: string;
}) {
  return (
    <Panel>
      <PanelTitle>{title}</PanelTitle>
      <div
        className="h-56 min-w-0"
        role="img"
        aria-label={`${title}, ${data.startDate} to ${data.endDate}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data.trend} margin={{ left: -20, right: 12 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="date" tickFormatter={(date) => String(date).slice(5)} minTickGap={40} />
            <YAxis allowDecimals={false} />
            <Tooltip labelFormatter={(date) => String(date)} />
            <Line
              name={field === "calls" ? "Calls" : "Appointments"}
              type="linear"
              dataKey={field}
              stroke="var(--primary)"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-muted-foreground">View daily numbers</summary>
        <div className="max-h-56 overflow-auto">
          <table className="w-full text-left">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col">Clinic date</th>
                <th scope="col" className="text-right">
                  Count
                </th>
              </tr>
            </thead>
            <tbody>
              {data.trend.map((row) => (
                <tr key={row.date}>
                  <td>{row.date}</td>
                  <td className="text-right tabular-nums">{row[field]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Panel>
  );
}
function Breakdown({
  title,
  rows,
  other,
}: {
  title: string;
  rows: { label: string; count: number }[];
  other: number;
}) {
  return (
    <Panel>
      <PanelTitle>{title}</PanelTitle>
      {!rows.length ? (
        <Empty>No appointments in this date range.</Empty>
      ) : (
        <ul className="space-y-3">
          {rows.map((row, index) => (
            <li
              key={index}
              className="flex items-start justify-between gap-4 border-b border-border pb-2"
            >
              <span className="min-w-0 break-words text-sm">{row.label || "Unspecified"}</span>
              <span className="shrink-0 font-medium tabular-nums">
                {row.count.toLocaleString()}
              </span>
            </li>
          ))}
          {other > 0 && (
            <li className="flex justify-between gap-4 text-sm">
              <span>Other groups</span>
              <span>{other.toLocaleString()}</span>
            </li>
          )}
        </ul>
      )}
    </Panel>
  );
}
