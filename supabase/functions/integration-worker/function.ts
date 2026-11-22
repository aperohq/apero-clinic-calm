import { clients, config, accessToken, reply } from "../_shared/integrations/runtime.ts";
import type { Env } from "../_shared/integrations/runtime.ts";
import { equalSecret, randomSecret, sha256 } from "../_shared/integrations/crypto.ts";
import { GoogleCalendarAdapter } from "../_shared/integrations/google.ts";
import { ProviderError, retryDelay } from "../_shared/integrations/adapter.ts";
import type { IntegrationAppointment } from "../_shared/integrations/adapter.ts";
export function createIntegrationWorker(env: Env, fetcher: typeof fetch = fetch, cleanup = true) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return reply(405, { code: "method_not_allowed" });
    const secret = env("INTEGRATION_WORKER_SECRET");
    const supplied = req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "";
    if (
      !secret ||
      secret.length < 32 ||
      supplied.length > 256 ||
      !(await equalSecret(secret, supplied))
    )
      return reply(401, { code: "not_authorized" });
    if (env("INTEGRATIONS_ENABLED") !== "true")
      return reply(503, { code: "integrations_disabled" });
    const started = Date.now();
    try {
      config(env); // Fail before claiming any work if configuration is incomplete.
      const { admin } = clients(env, fetcher);
      if (cleanup) {
        const clean = await admin.rpc("integration_cleanup");
        if (clean.error) return reply(503, { code: "database_unavailable" });
      }
      const claimed = await admin.rpc("integration_claim");
      if (claimed.error) return reply(503, { code: "database_unavailable" });
      if (!claimed.data) return reply(200, { processed: 0 });
      const { connection: c, job, lease } = claimed.data;
      let error: string | null = null,
        delay = 0;
      try {
        const token = await accessToken(admin, env, c, fetcher, lease),
          adapter = new GoogleCalendarAdapter(token, fetcher);
        const live = await admin
          .from("calendar_connections")
          .select("id")
          .eq("id", c.id)
          .eq("lease_id", lease)
          .gt("lease_until", new Date().toISOString())
          .neq("status", "disconnected")
          .maybeSingle();
        if (live.error || !live.data) throw new Error("lease_lost");
        if (job.kind === "push") {
          const link = await admin.rpc("integration_event_link", {
            p_connection: c.id,
            p_lease: lease,
            p_appointment: job.object_id,
            p_rotate: false,
          });
          if (link.error || typeof link.data !== "string")
            throw new Error("event_link_unavailable");
          const eventId = link.data;
          const result = await admin
            .from("appointments")
            .select("id,staff_id,status,start_time,end_time")
            .eq("clinic_id", c.clinic_id)
            .eq("id", job.object_id)
            .maybeSingle();
          if (result.error) throw new Error("database_unavailable");
          const appointment = result.data as IntegrationAppointment | null;
          if (
            !appointment ||
            appointment.status === "Cancelled" ||
            appointment.staff_id !== c.staff_id
          )
            await adapter.cancel(c.calendar_id, job.object_id, eventId);
          else {
            // A fresh provider check catches changes not yet delivered by webhook.
            const busy = await adapter.busy(
              c.calendar_id,
              appointment.start_time,
              appointment.end_time,
            );
            if (
              busy.some(
                (b) =>
                  b.id !== eventId &&
                  Date.parse(b.start) < Date.parse(appointment.end_time) &&
                  Date.parse(b.end) > Date.parse(appointment.start_time),
              )
            )
              throw new ProviderError("external_calendar_conflict", false);
            await adapter.upsert(c.calendar_id, appointment, eventId);
          }
          const queued = await admin.rpc("integration_enqueue", {
            p_connection: c.id,
            p_kind: "pull",
            p_object: "calendar",
          });
          if (queued.error) throw new Error("database_unavailable");
        } else {
          const from = new Date(Date.now() - 86400000).toISOString(),
            until = new Date(Date.now() + 90 * 86400000).toISOString();
          const events = await adapter.busy(c.calendar_id, from, until);
          const result = await admin.rpc("integration_replace_busy", {
            p_connection: c.id,
            p_lease: lease,
            p_from: from,
            p_until: until,
            p_events: events,
            p_generation: job.generation,
          });
          if (result.error) throw new Error("snapshot_not_saved");
          // Polling is always active. Push watches accelerate invalidation and are renewed before expiry.
          const callback = env("GOOGLE_WEBHOOK_URI");
          if (
            callback &&
            (!c.resource_id ||
              !c.channel_expires_at ||
              Date.parse(c.channel_expires_at) < Date.now() + 3600000)
          ) {
            const expected = new URL(
              (env("SUPABASE_URL") ?? "") + "/functions/v1/google-calendar-webhook",
            );
            if (new URL(callback).href !== expected.href || expected.protocol !== "https:")
              throw new Error("webhook_not_configured");
            const channel = crypto.randomUUID(),
              channelSecret = randomSecret(),
              expiration = Date.now() + 86400000;
            const saved = await admin
              .from("calendar_connections")
              .update({
                channel_id: channel,
                channel_hash: await sha256(channelSecret),
                channel_expires_at: new Date(expiration).toISOString(),
                resource_id: null,
                message_number: 0,
              })
              .eq("id", c.id)
              .eq("lease_id", lease)
              .neq("status", "disconnected");
            if (saved.error) throw new Error("database_unavailable");
            const response = await fetcher(
              `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.calendar_id)}/events/watch`,
              {
                method: "POST",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: JSON.stringify({
                  id: channel,
                  type: "web_hook",
                  address: callback,
                  token: channelSecret,
                  expiration: String(expiration),
                }),
                redirect: "error",
                signal: AbortSignal.timeout(15000),
              },
            );
            if (!response.ok)
              throw new ProviderError(
                `google_http_${response.status}`,
                response.status === 429 || response.status >= 500,
              );
            const watch = await response.json();
            if (
              typeof watch.resourceId !== "string" ||
              !Number.isFinite(Number(watch.expiration)) ||
              Number(watch.expiration) <= Date.now()
            )
              throw new Error("watch_invalid_response");
            const updated = await admin
              .from("calendar_connections")
              .update({
                resource_id: watch.resourceId,
                channel_expires_at: new Date(Number(watch.expiration)).toISOString(),
              })
              .eq("id", c.id)
              .eq("lease_id", lease)
              .eq("channel_id", channel)
              .neq("status", "disconnected");
            if (updated.error) throw new Error("database_unavailable");
          }
        }
      } catch (e) {
        let failure = e;
        if (
          e instanceof ProviderError &&
          e.code === "google_event_deleted" &&
          job.kind === "push"
        ) {
          const rotated = await admin.rpc("integration_event_link", {
            p_connection: c.id,
            p_lease: lease,
            p_appointment: job.object_id,
            p_rotate: true,
          });
          if (!rotated.error) failure = new ProviderError("google_event_recreated_pending", true);
        }
        error = failure instanceof ProviderError ? failure.code : "integration_worker_failed";
        delay =
          failure instanceof ProviderError && !failure.retryable
            ? 3600
            : retryDelay(job.attempts, failure instanceof ProviderError ? failure.retryAfter : 0);
      }
      const finished = await admin.rpc("integration_finish", {
        p_job: job.id,
        p_lease: lease,
        p_generation: job.generation,
        p_error: error,
        p_delay: delay,
      });
      // Fixed metadata only; no provider payload or secrets.
      console.info(
        JSON.stringify({
          component: "integration-worker",
          event: error ? "job_failed" : "job_finished",
          connection_id: c.id,
          job_id: job.id,
          code: error,
          duration_ms: Date.now() - started,
        }),
      );
      if (finished.error) return reply(503, { code: "job_completion_failed" });
      return reply(200, { processed: 1, failed: !!error });
    } catch {
      return reply(503, { code: "worker_unavailable" });
    }
  };
}

/** Bounded drain for the scheduled Edge entry point; each job remains individually leased. */
export function createIntegrationDrain(env: Env, fetcher: typeof fetch = fetch) {
  return async (req: Request): Promise<Response> => {
    const started = Date.now();
    const deadline = AbortSignal.any([req.signal, AbortSignal.timeout(50000)]);
    const transport: typeof fetch = (input, init) =>
      fetcher(input, {
        ...init,
        signal: AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]),
      });
    let processed = 0,
      failed = 0;
    for (let i = 0; i < 20 && Date.now() - started < 40000; i++) {
      const response = await createIntegrationWorker(env, transport, i === 0)(req);
      if (!response.ok) return response;
      const result = (await response.json()) as { processed: number; failed?: boolean };
      processed += result.processed;
      if (result.failed) failed++;
      if (!result.processed) break;
    }
    return reply(200, { processed, failed });
  };
}
