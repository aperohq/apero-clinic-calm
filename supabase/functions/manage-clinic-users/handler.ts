import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ClinicUserProvisionError,
  finishClinicInvitation,
  invitationRedirect,
  provisionClinicUser,
  reserveClinicInvitation,
} from "../_shared/clinic-users.ts";
import { readLimitedBody, RequestBodyTooLargeError } from "../_shared/request-security.ts";

const inputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("invite"),
      email: z.string().trim().email().max(254),
      fullName: z.string().trim().min(1).max(200),
      role: z.enum(["manager", "staff"]),
    })
    .strict(),
  z.object({ action: z.literal("resend"), profileId: z.string().uuid() }).strict(),
]);
export type TeamContext = {
  authUserId: string;
  userClient: SupabaseClient;
  admin: SupabaseClient;
  signal?: AbortSignal;
};

export function createTeamHandler(portalOrigin: string) {
  const redirectTo = invitationRedirect(portalOrigin);
  return async (req: Request, ctx: TeamContext): Promise<Response> => {
    const json = (status: number, code: string) => Response.json({ code }, { status });
    const actor = await ctx.userClient
      .from("profiles")
      .select("id,clinic_id,role,revoked_at")
      .eq("auth_user_id", ctx.authUserId)
      .maybeSingle();
    if (actor.error) return json(503, "unavailable");
    if (!actor.data || actor.data.role !== "owner" || actor.data.revoked_at)
      return json(403, "not_authorized");
    let input: z.infer<typeof inputSchema>;
    try {
      input = inputSchema.parse(
        JSON.parse(await readLimitedBody(req, 4096, ctx.signal ?? req.signal)),
      );
    } catch (error) {
      if (ctx.signal?.aborted || req.signal.aborted) return json(503, "unavailable");
      return json(error instanceof RequestBodyTooLargeError ? 413 : 400, "invalid_input");
    }
    let token: string | undefined;
    try {
      let email: string, fullName: string, authUserId: string, profileId: string;
      const reservation = await reserveClinicInvitation(ctx.admin, {
        actorAuthId: ctx.authUserId,
        clinicId: null,
        email: input.action === "invite" ? input.email.toLowerCase() : null,
        action: input.action,
        profileId: input.action === "resend" ? input.profileId : undefined,
      });
      token = reservation.token;
      if (input.action === "invite") {
        email = reservation.email;
        fullName = input.fullName;
        const result = await provisionClinicUser(
          ctx.admin,
          {
            mode: "invite",
            clinicId: reservation.clinic_id,
            email,
            fullName,
          },
          portalOrigin,
          { authUserId: ctx.authUserId, role: input.role, reservation },
        );
        authUserId = result.authUserId;
        profileId = result.profileId;
      } else {
        if (
          !reservation.auth_user_id ||
          !reservation.profile_id ||
          !reservation.full_name ||
          !reservation.role
        )
          return json(503, "unavailable");
        email = reservation.email;
        fullName = reservation.full_name;
        authUserId = reservation.auth_user_id;
        // Locks/rechecks Owner and target in the database. No role reassignment.
        const checked = await ctx.admin.rpc("owner_invite_clinic_member", {
          p_actor_auth_id: ctx.authUserId,
          p_auth_user_id: authUserId,
          p_email: email,
          p_full_name: fullName,
          p_role: reservation.role,
        });
        if (checked.error || checked.data !== reservation.profile_id)
          return json(403, "not_authorized");
        profileId = reservation.profile_id;
      }
      // Reuse Supabase Auth's invitation mailer and existing /account/setup.
      // Membership is verified before any email is sent. Tokens never leave Edge.
      const sent = await ctx.admin.auth.admin.inviteUserByEmail(email, {
        redirectTo,
        data: { full_name: fullName },
      });
      if (sent.error || sent.data.user?.id !== authUserId) return json(502, "invite_email_failed");
      return Response.json({ code: "invite_sent", profileId }, { status: 200 });
    } catch (error) {
      if (error instanceof ClinicUserProvisionError) {
        const allowed = [
          "not_authorized",
          "invalid_input",
          "invite_pending",
          "already_member",
          "access_revoked",
          "invite_recent",
          "rate_limited",
        ];
        if (allowed.includes(error.code))
          return json(
            error.code === "not_authorized"
              ? 403
              : ["invite_recent", "rate_limited"].includes(error.code)
                ? 429
                : 409,
            error.code,
          );
      }
      // Do not disclose global Auth-account existence, foreign-clinic membership,
      // provider diagnostics, invitation links or credentials.
      return json(409, "invite_unavailable");
    } finally {
      if (token) await finishClinicInvitation(ctx.admin, token);
    }
  };
}
