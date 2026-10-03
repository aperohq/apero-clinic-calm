// Shared operator provisioning for the Edge handler and private Node tool.
// Call only after operator authorization; the approved clinic is server input.
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

const fields = {
  clinicId: z.string().uuid(),
  email: z
    .string()
    .trim()
    .email()
    .transform((value) => value.toLowerCase()),
  fullName: z.string().trim().min(1).max(200),
};
const requestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("invite"), ...fields }).strict(),
  z.object({ mode: z.literal("associate"), ...fields, authUserId: z.string().uuid() }).strict(),
]);
export type ClinicUserRequest = z.infer<typeof requestSchema>;
export function parseClinicUserRequest(input: unknown): ClinicUserRequest {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success)
    throw new Error("Invalid provisioning input; use the documented fields only.");
  return parsed.data;
}
export function invitationRedirect(portalOrigin: string): string {
  const url = new URL(portalOrigin);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  ) {
    throw new Error("Portal origin must be HTTPS (HTTP is allowed only for local testing).");
  }
  return `${url.origin}/account/setup`;
}
export class ClinicUserProvisionError extends Error {
  readonly authUserId: string | null;
  code = "invite_unavailable";
  constructor(message: string, authUserId: string | null = null) {
    super(message);
    this.name = "ClinicUserProvisionError";
    this.authUserId = authUserId;
  }
}
export type InvitationReservation = {
  code: string;
  token: string;
  clinic_id: string;
  email: string;
  auth_user_id: string | null;
  profile_id: string | null;
  full_name: string | null;
  role: "manager" | "staff" | null;
};
export async function reserveClinicInvitation(
  admin: SupabaseClient,
  input: {
    actorAuthId: string | null;
    clinicId: string | null;
    email: string | null;
    action: "invite" | "resend" | "operator_invite" | "operator_associate";
    profileId?: string | undefined;
  },
): Promise<InvitationReservation> {
  const { data, error } = await admin.rpc("reserve_clinic_invitation", {
    p_actor_auth_id: input.actorAuthId,
    p_clinic_id: input.clinicId,
    p_email: input.email,
    p_action: input.action,
    p_profile_id: input.profileId ?? null,
  });
  if (error || data?.code !== "ready" || typeof data.token !== "string") {
    const failure = new ClinicUserProvisionError(
      "Invitation unavailable; retry later or contact Apero.",
    );
    failure.code = !error && typeof data?.code === "string" ? data.code : "invite_unavailable";
    throw failure;
  }
  return data;
}
export async function finishClinicInvitation(admin: SupabaseClient, token: string) {
  // One best-effort cleanup, no retries. A failed/aborted cleanup leaves the
  // 90-second same-clinic lease; permanent cross-clinic ownership stays intact.
  try {
    await admin.rpc("finish_clinic_invitation", { p_token: token });
  } catch {
    /* lease recovery */
  }
}
export async function provisionClinicUser(
  admin: SupabaseClient,
  input: unknown,
  portalOrigin: string,
  owner?: { authUserId: string; role: "manager" | "staff"; reservation: InvitationReservation },
) {
  const request = parseClinicUserRequest(input);
  invitationRedirect(portalOrigin);
  if (owner && (request.mode !== "invite" || !["manager", "staff"].includes(owner.role)))
    throw new ClinicUserProvisionError("Invalid invitation role.");
  const reservation =
    owner?.reservation ??
    (await reserveClinicInvitation(admin, {
      actorAuthId: null,
      clinicId: request.clinicId,
      email: request.email,
      action: request.mode === "invite" ? "operator_invite" : "operator_associate",
    }));
  if (reservation.clinic_id !== request.clinicId || reservation.email !== request.email)
    throw new ClinicUserProvisionError("Invitation unavailable.");
  try {
    return await provisionReservedClinicUser(admin, request, portalOrigin, owner);
  } finally {
    // Team handler holds admission through the final Auth mail call. Operator
    // paths share the same claim around generation/association and profile work.
    if (!owner) await finishClinicInvitation(admin, reservation.token);
  }
}
async function provisionReservedClinicUser(
  admin: SupabaseClient,
  input: unknown,
  portalOrigin: string,
  owner?: { authUserId: string; role: "manager" | "staff" },
) {
  const request = parseClinicUserRequest(input);
  if (owner && (request.mode !== "invite" || !["manager", "staff"].includes(owner.role)))
    throw new ClinicUserProvisionError("Invalid invitation role.");
  const redirectTo = invitationRedirect(portalOrigin);
  const fail = (message: string, id: string | null = null): never => {
    // Provider error bodies and invitation tokens must never appear in errors.
    throw new ClinicUserProvisionError(message, id);
  };
  if (!owner) {
    const { data: clinic, error: clinicError } = await admin
      .from("clinics")
      .select("id")
      .eq("id", request.clinicId)
      .maybeSingle();
    if (clinicError || clinic?.id !== request.clinicId)
      fail("Clinic not found or could not be verified.");
  }

  let userId: string;
  let invitationUrl: string | null = null;
  if (request.mode === "invite") {
    // Generates an Auth invitation/account without sending email. Release the
    // link only after its database profile is verified in the approved clinic.
    const { data, error } = await admin.auth.admin.generateLink({
      type: "invite",
      email: request.email,
      options: { redirectTo, data: { full_name: request.fullName } },
    });
    if (
      error ||
      !data.user?.id ||
      data.user.email?.toLowerCase() !== request.email ||
      data.properties?.verification_type !== "invite" ||
      !data.properties.action_link
    ) {
      return fail(
        "Invitation could not be generated. Existing accounts require explicit association.",
      );
    }
    userId = data.user.id;
    invitationUrl = data.properties.action_link;
  } else {
    const { data, error } = await admin.auth.admin.getUserById(request.authUserId);
    if (
      error ||
      data.user?.id !== request.authUserId ||
      data.user.email?.toLowerCase() !== request.email ||
      !data.user.email_confirmed_at
    ) {
      return fail("Existing verified Auth account does not match the supplied identity.");
    }
    userId = data.user.id;
  }

  const readProfile = () =>
    admin
      .from("profiles")
      .select("id,auth_user_id,clinic_id")
      .eq("auth_user_id", userId)
      .maybeSingle();
  if (owner) {
    const { data: profileId, error } = await admin.rpc("owner_invite_clinic_member", {
      p_actor_auth_id: owner.authUserId,
      p_auth_user_id: userId,
      p_email: request.email,
      p_full_name: request.fullName,
      p_role: owner.role,
    });
    if (error || typeof profileId !== "string")
      return fail("Invitation unavailable; no account reassignment was performed.", userId);
    const { data: verified, error: verifyError } = await readProfile();
    if (verifyError || verified?.id !== profileId || verified.clinic_id !== request.clinicId)
      return fail("Clinic membership could not be verified.", userId);
    return { authUserId: userId, profileId, clinicId: request.clinicId, invitationUrl };
  }
  let { data: profile, error: readError } = await readProfile();
  if (readError) return fail("Profile could not be verified; invitation was withheld.", userId);
  if (!profile) {
    // INSERT only: UNIQUE(auth_user_id) handles concurrent attempts. Never
    // upsert/update membership or role, including on retry or duplicate email.
    const { error } = await admin.from("profiles").insert({
      auth_user_id: userId,
      clinic_id: request.clinicId,
      email: request.email,
      full_name: request.fullName,
      role: "staff",
    });
    if (error && error.code !== "23505") {
      return fail(
        "Profile creation failed; invitation was withheld. Inspect this Auth account before retrying.",
        userId,
      );
    }
    ({ data: profile, error: readError } = await readProfile());
  }
  if (
    readError ||
    !profile ||
    profile.auth_user_id !== userId ||
    profile.clinic_id !== request.clinicId
  ) {
    return fail(
      "Account is linked elsewhere or membership could not be verified; no reassignment was performed.",
      userId,
    );
  }
  return { authUserId: userId, profileId: profile.id, clinicId: request.clinicId, invitationUrl };
}
