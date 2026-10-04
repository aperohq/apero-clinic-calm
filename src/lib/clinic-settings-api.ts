import { db } from "./db";
import {
  changedSettings,
  normalizeSettings,
  SETTINGS_FIELDS,
  type ClinicSettings,
  type SettingsDraft,
} from "./clinic-settings";
import type { Json } from "./db-types";

export class SettingsRequestError extends Error {}

export async function loadClinicSettings(clinicId: string): Promise<ClinicSettings> {
  const { data, error } = await db
    .from("clinics")
    .select(SETTINGS_FIELDS.join(","))
    .eq("id", clinicId)
    .single();
  if (error || !data)
    throw new SettingsRequestError("Could not load clinic settings. Please try again.");
  return data as unknown as ClinicSettings;
}
export async function saveClinicSettings(
  original: ClinicSettings,
  draft: SettingsDraft,
): Promise<ClinicSettings> {
  const next = normalizeSettings(draft, original),
    patch = changedSettings(original, next);
  if (!Object.keys(patch).length) return original;
  const expected = Object.fromEntries(
    Object.keys(patch).map((key) => [key, original[key as keyof ClinicSettings] ?? null]),
  );
  const response = await db
    .rpc("update_clinic_settings", {
      p_patch: patch as Json,
      p_expected: expected as Json,
    })
    .single()
    .then(
      (result) => result,
      () => {
        throw new SettingsRequestError(
          "Could not save clinic settings. Your edits are safe. Please try again.",
        );
      },
    );
  const { data, error } = response;
  if (error?.code === "40001")
    throw new SettingsRequestError(
      "These settings changed in another session. Your edits are safe. Reload the saved values before trying again.",
    );
  if (error || !data)
    throw new SettingsRequestError(
      "Could not save clinic settings. Your edits are safe. Please try again.",
    );
  return Object.fromEntries(SETTINGS_FIELDS.map((key) => [key, data[key]])) as ClinicSettings;
}
