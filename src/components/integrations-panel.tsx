import { useEffect, useState, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { db } from "@/lib/db";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, PanelTitle } from "@/components/page-ui";

type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
};
type Connection = {
  id: string;
  calendar_id: string | null;
  staff_id: string | null;
  status: string;
  last_synced_at: string | null;
  last_error: string | null;
  busy_until: string | null;
};
type Dashboard = { keys: ApiKey[]; connections: Connection[]; failed_jobs: number };
type Staff = { id: string; full_name: string };
// Keep credentials out of persistent client storage, URLs and query caches.
export function IntegrationsPanel() {
  const { role, clinicId } = useAuth();
  if (import.meta.env?.["VITE_APERO_INTEGRATIONS_ENABLED"] !== "true") return null;
  return role === "owner" && clinicId ? (
    <OwnerIntegrations key={clinicId} clinicId={clinicId} />
  ) : null;
}
function OwnerIntegrations({ clinicId }: { clinicId: string }) {
  const oauthCompletion = useRef<Promise<void> | null>(null);
  const [data, setData] = useState<Dashboard | null>(null),
    [staff, setStaff] = useState<Staff[]>([]);
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState(""),
    [name, setName] = useState(""),
    [scopes, setScopes] = useState<string[]>(["availability:read"]);
  const [calendars, setCalendars] = useState<Record<string, Array<{ id: string; name: string }>>>(
    {},
  );
  const [selectedCalendar, setSelectedCalendar] = useState<Record<string, string>>({}),
    [selectedStaff, setSelectedStaff] = useState<Record<string, string>>({});
  async function load() {
    const result = await db.rpc("integration_dashboard");
    if (result.error)
      throw new Error("Integrations are unavailable. Try again or contact support.");
    const members = await db
      .from("staff")
      .select("id,full_name")
      .eq("clinic_id", clinicId!)
      .eq("active", true);
    if (members.error) throw new Error("Could not load practitioners.");
    setData(result.data as unknown as Dashboard);
    setStaff(members.data);
  }
  useEffect(() => {
    setData(null);
    setSecret("");
    setCalendars({});
    setSelectedCalendar({});
    setSelectedStaff({});
    setError("");

    let active = true;
    // Avoid retaining another clinic's response if membership changes during loading.
    void (async () => {
      const query = new URLSearchParams(window.location.search);
      const code = query.get("integration_code"),
        state = query.get("integration_state"),
        denied = query.get("integration_error");
      if (code || state || denied) {
        for (const key of ["integration_code", "integration_state", "integration_error"])
          query.delete(key);
        window.history.replaceState(
          null,
          "",
          window.location.pathname +
            (query.size ? "?" + query.toString() : "") +
            window.location.hash,
        );
        const saved = window.sessionStorage.getItem("apero-google-state:" + clinicId);
        window.sessionStorage.removeItem("apero-google-state:" + clinicId);
        if (denied) {
          setError("Google authorization was not completed. Connect again when ready.");
          return;
        }
        if (!state || !code || saved !== state) {
          setError(
            "This authorization did not start in this browser. Connect Google Calendar again.",
          );
          return;
        }
        oauthCompletion.current = (async () => {
          await manage("oauth/complete", { state, code });
        })();
      }
      try {
        if (oauthCompletion.current) await oauthCompletion.current;
      } catch {
        if (active) setError("Google authorization could not be completed. Connect again.");
        return;
      }
      const result = await db.rpc("integration_dashboard");
      const members = await db
        .from("staff")
        .select("id,full_name")
        .eq("clinic_id", clinicId)
        .eq("active", true);
      if (!active) return;
      if (result.error || members.error)
        setError("Integrations are unavailable. Try again or contact support.");
      else {
        setData(result.data as unknown as Dashboard);
        setStaff(members.data);
      }
    })();
    return () => {
      active = false;
    };
  }, [clinicId]);

  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await task();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The action failed. Try again.");
    } finally {
      setBusy(false);
    }
  }
  async function manage(path: string, input: Record<string, unknown>) {
    const response = await supabase.functions.invoke("integration-api/manage/" + path, {
      body: input,
    });
    if (response.error)
      throw new Error("Could not update the integration. Check the connection and try again.");
    return response.data;
  }
  async function keyAction(key?: ApiKey) {
    if (!name.trim() && !key) throw new Error("Enter a key name.");
    if (!key && scopes.length === 0) throw new Error("Select at least one permission.");
    const result = await db.rpc("integration_create_key", {
      p_name: key?.name ?? name.trim(),
      p_scopes: key?.scopes ?? scopes,
      p_rotate_id: key?.id ?? null,
    });
    if (result.error) throw new Error("Could not create the key.");
    setSecret((result.data as unknown as { key: string }).key);
    setName("");
    setMessage(
      key
        ? "Key rotated. The previous key is revoked."
        : "Key created. Save it now; it will only be shown once.",
    );
  }
  return (
    <Panel>
      <PanelTitle>Integrations</PanelTitle>
      <p className="text-sm text-muted-foreground">
        Manage clinic API access and Google Calendar connections.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button variant="outline" disabled={busy} onClick={() => void run(load)}>
          Refresh status
        </Button>
        <Button
          disabled={busy || !data}
          onClick={() =>
            void run(async () => {
              const result = await manage("oauth/start", {});
              const target = new URL(result.url);
              if (target.origin !== "https://accounts.google.com")
                throw new Error("Invalid authorization link.");
              if (typeof result.state !== "string" || !/^[a-f0-9]{64}$/.test(result.state))
                throw new Error("Invalid authorization state.");
              window.sessionStorage.setItem("apero-google-state:" + clinicId, result.state);
              window.location.assign(target.href);
            })
          }
        >
          Connect Google Calendar
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mt-3 text-sm">
          {message}
        </p>
      )}
      {data && (
        <>
          {data.failed_jobs > 0 && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {data.failed_jobs} synchronization job(s) need attention. Retry the affected
              connection or contact support.
            </p>
          )}
          <div className="mt-5 space-y-4">
            {data.connections.map((c) => (
              <section
                key={c.id}
                aria-label="Calendar connection"
                className="rounded-xl border p-4 min-w-0"
              >
                <p className="break-all font-medium">{c.calendar_id ?? "Choose a calendar"}</p>
                <p className="text-sm">
                  Status: {c.status}
                  {c.last_synced_at &&
                    ` · Last synchronized ${new Date(c.last_synced_at).toLocaleString()}`}
                </p>
                {c.last_error && (
                  <p role="alert" className="text-sm text-destructive">
                    Synchronization needs attention: {c.last_error.replaceAll("_", " ")}.
                  </p>
                )}
                {c.calendar_id &&
                  c.status !== "disconnected" &&
                  (!c.last_synced_at || Date.now() - Date.parse(c.last_synced_at) > 300000) && (
                    <p className="text-sm text-destructive">
                      Calendar availability is stale. New bookings are paused for this practitioner
                      until synchronization recovers.
                    </p>
                  )}
                {!c.calendar_id && c.status !== "disconnected" && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const result = await manage("calendars", { connection_id: c.id });
                          setCalendars((old) => ({ ...old, [c.id]: result.calendars }));
                        })
                      }
                    >
                      Load writable calendars
                    </Button>
                    <label className="text-sm">
                      Calendar
                      <select
                        aria-label="Calendar"
                        className="mt-1 w-full rounded-md border bg-background p-2"
                        value={selectedCalendar[c.id] ?? ""}
                        onChange={(e) =>
                          setSelectedCalendar((old) => ({ ...old, [c.id]: e.target.value }))
                        }
                      >
                        <option value="">Select calendar</option>
                        {(calendars[c.id] ?? []).map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-sm">
                      Practitioner
                      <select
                        aria-label="Practitioner"
                        className="mt-1 w-full rounded-md border bg-background p-2"
                        value={selectedStaff[c.id] ?? ""}
                        onChange={(e) =>
                          setSelectedStaff((old) => ({ ...old, [c.id]: e.target.value }))
                        }
                      >
                        <option value="">Select practitioner</option>
                        {staff.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.full_name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Button
                      disabled={busy || !selectedCalendar[c.id] || !selectedStaff[c.id]}
                      onClick={() =>
                        void run(async () => {
                          await manage("select", {
                            connection_id: c.id,
                            calendar_id: selectedCalendar[c.id],
                            staff_id: selectedStaff[c.id],
                          });
                          setMessage(
                            "Calendar selected. Synchronization must finish before booking becomes available.",
                          );
                        })
                      }
                    >
                      Use calendar
                    </Button>
                  </div>
                )}
                {c.status !== "disconnected" && (
                  <div className="mt-3 flex flex-wrap gap-3">
                    {c.calendar_id && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await manage("retry", { connection_id: c.id });
                            setMessage("Synchronization queued. Refresh status shortly.");
                          })
                        }
                      >
                        Retry synchronization
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await manage("disconnect", { connection_id: c.id });
                          setMessage(
                            "Disconnected. Existing Google events remain. Remove Apero access in your Google account if needed.",
                          );
                        })
                      }
                    >
                      Disconnect
                    </Button>
                  </div>
                )}
              </section>
            ))}
          </div>
          <h3 className="mt-6 font-medium">Clinic API keys</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Keys expire after 90 days. Rotation immediately revokes the previous key.
          </p>
          <label className="mt-3 block text-sm">
            Key name
            <Input
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
            />
          </label>
          <fieldset className="mt-3 flex flex-wrap gap-4">
            <legend className="text-sm">Permissions</legend>
            {["availability:read", "appointments:read", "appointments:write"].map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(e) =>
                    setScopes((old) =>
                      e.target.checked ? [...old, scope] : old.filter((s) => s !== scope),
                    )
                  }
                />
                {scope.replace(":", " — ")}
              </label>
            ))}
          </fieldset>
          <Button
            className="mt-3"
            disabled={busy || !name.trim() || scopes.length === 0}
            onClick={() => void run(() => keyAction())}
          >
            Create API key
          </Button>
          {secret && (
            <div className="mt-3 rounded-xl border p-3">
              <p className="text-sm">
                Save this key in your secret manager. It will not be shown again.
              </p>
              <code className="mt-2 block break-all select-all text-sm">{secret}</code>
              <Button variant="outline" className="mt-2" onClick={() => setSecret("")}>
                Hide key
              </Button>
            </div>
          )}
          <div className="mt-4 space-y-3">
            {data.keys.map((k) => (
              <div key={k.id} className="rounded-xl border p-3">
                <p className="break-words font-medium">
                  {k.name} <span className="text-sm text-muted-foreground">{k.prefix}…</span>
                </p>
                <p className="text-sm">
                  {k.revoked_at
                    ? "Revoked"
                    : Date.parse(k.expires_at) <= Date.now()
                      ? "Expired"
                      : `Expires ${new Date(k.expires_at).toLocaleDateString()}`}{" "}
                  · {k.scopes.join(", ")}
                </p>
                {!k.revoked_at && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void run(() => keyAction(k))}
                    >
                      Rotate key
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const result = await db.rpc("integration_revoke_key", { p_id: k.id });
                          if (result.error) throw new Error("Could not revoke the key.");
                          setSecret("");
                          setMessage("API key revoked.");
                        })
                      }
                    >
                      Revoke key
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}
