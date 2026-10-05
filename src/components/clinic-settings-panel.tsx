import { useEffect, useRef, useState } from "react";
import { useBlocker } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import {
  loadClinicSettings,
  saveClinicSettings,
  SettingsRequestError,
} from "@/lib/clinic-settings-api";
import {
  emptyHours,
  settingsDraft,
  SettingsValidationError,
  TEXT_LIMITS,
  WEEKDAYS,
  type ClinicHours,
  type ClinicSettings,
  type SettingsDraft,
} from "@/lib/clinic-settings";
import { Panel, PanelTitle } from "@/components/page-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Form = { clinicId: string; original: ClinicSettings; draft: SettingsDraft };
type TextField = Exclude<keyof SettingsDraft, "opening_hours" | "live_transfer_enabled">;

export function ClinicSettingsPanel() {
  const { clinicId, role, refreshProfile } = useAuth();
  const queryClient = useQueryClient();
  const canEdit = hasPermission(role, "clinic.configure");
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [discard, setDiscard] = useState(false);
  const saving = useRef(false);
  const identity = useRef({ clinicId, canEdit });
  identity.current = { clinicId, canEdit };
  useEffect(
    () => () => {
      identity.current = { clinicId: null, canEdit: false };
    },
    [],
  );
  const queryKey = ["clinic_settings", clinicId, role];
  const settings = useQuery({
    queryKey,
    enabled: !!clinicId && canEdit,
    retry: false,
    queryFn: () => loadClinicSettings(clinicId!),
  });
  const current = form?.clinicId === clinicId ? form : null;
  const dirty =
    !!current && JSON.stringify(current.draft) !== JSON.stringify(settingsDraft(current.original));
  useEffect(() => {
    if (settings.data && clinicId && !dirty) {
      setForm({ clinicId, original: settings.data, draft: settingsDraft(settings.data) });
    }
  }, [settings.data, clinicId, dirty]);
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => dirty && current.pathname !== next.pathname,
    enableBeforeUnload: dirty,
    disabled: !canEdit,
    withResolver: true,
  });
  const setField = (key: TextField, value: string) => {
    setMessage("");
    setError("");
    setForm((previous) =>
      previous ? { ...previous, draft: { ...previous.draft, [key]: value } } : previous,
    );
  };
  const setHours = (hours: ClinicHours | null) => {
    setMessage("");
    setError("");
    setForm((previous) =>
      previous ? { ...previous, draft: { ...previous.draft, opening_hours: hours } } : previous,
    );
  };
  const textField = (
    key: TextField,
    label: string,
    options: { type?: string; multiline?: boolean } = {},
  ) => (
    <div className={options.multiline ? "min-w-0 sm:col-span-2" : "min-w-0"}>
      <Label htmlFor={`settings-${key}`}>{label}</Label>
      {options.multiline ? (
        <Textarea
          id={`settings-${key}`}
          className="mt-2"
          maxLength={TEXT_LIMITS[key]}
          value={current!.draft[key]}
          onChange={(event) => setField(key, event.target.value)}
        />
      ) : (
        <Input
          id={`settings-${key}`}
          type={options.type ?? "text"}
          className="mt-2"
          maxLength={TEXT_LIMITS[key]}
          required={key === "name" || key === "timezone"}
          dir={key.includes("localized") ? "auto" : undefined}
          value={current!.draft[key]}
          onChange={(event) => setField(key, event.target.value)}
        />
      )}
    </div>
  );
  const save = async () => {
    if (!current || !clinicId || !canEdit || saving.current) return;
    saving.current = true;
    setBusy(true);
    setMessage("");
    setError("");
    const savedClinicId = clinicId;
    try {
      const saved = await saveClinicSettings(current.original, current.draft);
      if (identity.current.clinicId !== savedClinicId || !identity.current.canEdit) return;
      queryClient.setQueryData(queryKey, saved);
      setForm({ clinicId: savedClinicId, original: saved, draft: settingsDraft(saved) });
      setMessage("Clinic settings saved.");
      // Refresh the canonical clinic identity/timezone used across the dashboard.
      // Existing UTC appointment instants and practitioner schedules are untouched.
      await queryClient.invalidateQueries({ queryKey: ["appointment_slots"] });
      void refreshProfile(true);
    } catch (failure) {
      if (identity.current.clinicId === savedClinicId && identity.current.canEdit)
        setError(
          failure instanceof SettingsValidationError || failure instanceof SettingsRequestError
            ? failure.message
            : "Could not save clinic settings. Your edits are safe. Please try again.",
        );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  if (!canEdit || !clinicId) return null;
  if (settings.isPending || (!current && !settings.isError))
    return (
      <Panel>
        <p role="status">Loading clinic settings…</p>
      </Panel>
    );
  if (!current)
    return (
      <Panel>
        <p role="alert">Could not load clinic settings. Please try again.</p>
        <Button variant="outline" className="mt-4" onClick={() => void settings.refetch()}>
          Try again
        </Button>
      </Panel>
    );
  const hours = current.draft.opening_hours;
  const discardEdits = async () => {
    const result = await settings.refetch();
    if (result.data) {
      setForm({ clinicId, original: result.data, draft: settingsDraft(result.data) });
      setMessage("");
      setError("");
      setDiscard(false);
    } else setError("Could not reload clinic settings. Your edits are safe. Please try again.");
  };
  return (
    <>
      <form
        noValidate
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy} className="min-w-0 space-y-6">
          <Panel>
            <PanelTitle>Clinic profile</PanelTitle>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              {textField("name", "Clinic name")}
              {textField("localized_name", "Arabic / localized clinic name")}
              {textField("clinic_type", "Clinic type")}
              {textField("timezone", "Clinic timezone (IANA)")}
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Changing timezone changes how appointment times are displayed and how future available
              slots are interpreted. Existing appointments keep their original instants. Review
              upcoming bookings before saving a timezone change.
            </p>
          </Panel>
          <Panel>
            <PanelTitle>Contact &amp; location</PanelTitle>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              {textField("email", "Clinic email", { type: "email" })}
              {textField("website", "Website", { type: "url" })}
              {textField("phone", "Main phone", { type: "tel" })}
              {textField("address", "Address")}
              {textField("city", "Area / city")}
              {textField("country", "Country")}
              {textField("directions", "Directions", { multiline: true })}
              {textField("parking_information", "Parking information", { multiline: true })}
            </div>
          </Panel>
          <Panel>
            <PanelTitle>Clinic hours</PanelTitle>
            <p className="mb-4 text-sm text-muted-foreground">
              Public opening hours describe when your clinic operates. Practitioner availability and
              time off are managed separately in Staff; these hours do not restrict appointment
              availability.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={hours !== null}
                onChange={(event) => setHours(event.target.checked ? emptyHours() : null)}
              />
              Set public opening hours
            </label>
            {hours === null ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Public opening hours are not set.
              </p>
            ) : (
              <div className="mt-4 space-y-4">
                {WEEKDAYS.map((label, day) => {
                  const periods = hours.days.find((item) => item.day === day)?.periods ?? [];
                  const update = (next: typeof periods) =>
                    setHours({
                      days: hours.days.map((item) =>
                        item.day === day ? { day, periods: next } : item,
                      ),
                    });
                  return (
                    <div
                      key={day}
                      className="flex min-w-0 flex-wrap items-start gap-3 border-b border-border pb-4 last:border-0"
                    >
                      <div className="w-28 pt-2 text-sm font-medium">{label}</div>
                      <div className="min-w-0 flex-1 space-y-2">
                        {!periods.length && (
                          <p className="py-2 text-sm text-muted-foreground">Closed</p>
                        )}
                        {periods.map((period, index) => (
                          <div key={index} className="flex min-w-0 flex-wrap items-center gap-2">
                            <Input
                              type="time"
                              className="w-32"
                              aria-label={`${label} period ${index + 1} start`}
                              value={period.start}
                              onChange={(event) =>
                                update(
                                  periods.map((item, i) =>
                                    i === index ? { ...item, start: event.target.value } : item,
                                  ),
                                )
                              }
                            />
                            <span className="text-xs text-muted-foreground">to</span>
                            <Input
                              type="time"
                              className="w-32"
                              aria-label={`${label} period ${index + 1} end`}
                              value={period.end}
                              onChange={(event) =>
                                update(
                                  periods.map((item, i) =>
                                    i === index ? { ...item, end: event.target.value } : item,
                                  ),
                                )
                              }
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={`Remove ${label} period ${index + 1}`}
                              onClick={() => update(periods.filter((_, i) => i !== index))}
                            >
                              Remove
                            </Button>
                          </div>
                        ))}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={periods.length >= 4}
                          onClick={() => update([...periods, { start: "09:00", end: "17:00" }])}
                        >
                          Add {label} hours
                        </Button>
                      </div>
                    </div>
                  );
                })}
                <p className="text-xs text-muted-foreground">
                  Use separate periods for breaks. For overnight opening, split the hours across
                  days. No special holiday calendar is configured here.
                </p>
              </div>
            )}
          </Panel>
          <Panel>
            <PanelTitle>AI receptionist</PanelTitle>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              {textField("receptionist_name", "Receptionist name")}
              {textField("receptionist_localized_name", "Arabic / localized receptionist name")}
              {textField("fallback_phone", "Fallback / staff transfer phone", { type: "tel" })}
            </div>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input id="settings-live-transfer" type="checkbox" checked={current.draft.live_transfer_enabled} disabled={busy}
                onChange={(event) => setForm((previous) => previous ? {...previous,draft:{...previous.draft,live_transfer_enabled:event.target.checked}} : previous)} />
              Enable live staff transfer
            </label>
            <p className="mt-2 text-xs text-muted-foreground">
              Keep disabled until your phone provider and staff destination are ready. Enabled
              transfers use the fallback phone in international format and configured clinic hours.
              Missing destination or hours prevents transfer and uses clinic follow-up.
            </p>
            <p className="mt-4 text-xs text-muted-foreground">
              These details are saved for your clinic. Changes to information spoken in calls
              require Apero to synchronize the receptionist configuration. Live transfer also requires the enabled setting, a valid destination, and configured clinic hours.
            </p>
          </Panel>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {message && (
            <p role="status" className="text-sm text-success-strong">
              {message}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-3">
            {dirty && (
              <span className="mr-auto text-sm text-muted-foreground">Unsaved changes</span>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={settings.isFetching}
              onClick={() => (dirty ? setDiscard(true) : void discardEdits())}
            >
              Reload saved values
            </Button>
            <Button type="submit" disabled={!dirty || busy}>
              {busy ? "Saving…" : "Save settings"}
            </Button>
          </div>
        </fieldset>
      </form>
      <Dialog
        open={discard || blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) {
            setDiscard(false);
            blocker.reset?.();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>Your clinic settings have not been saved.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDiscard(false);
                blocker.reset?.();
              }}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (blocker.status === "blocked") blocker.proceed();
                else void discardEdits();
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
