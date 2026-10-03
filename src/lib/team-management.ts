import { db } from "@/lib/db";
import type { TeamMemberRow } from "@/lib/db-types";

export async function loadTeam(): Promise<TeamMemberRow[]> {
  const rows: TeamMemberRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.rpc("clinic_team_members", {}).range(offset, offset + 999);
    if (error) throw new Error("Could not load clinic accounts.");
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < 1000) return rows;
  }
}

const messages: Record<string, string> = {
  invalid_input: "Enter a valid name, email address and Manager or Staff role.",
  not_authorized: "Only an active clinic Owner can invite users. Refresh and try again.",
  already_member: "This user already has a clinic account.",
  invite_pending: "This user has a pending invitation. Use Resend invitation for a fresh link.",
  access_revoked:
    "This account's access has been revoked. Contact Apero if it needs to be restored.",
  invite_email_failed:
    "The account is ready, but the invitation email could not be sent. Refresh the team and use Resend invitation.",
  invite_unavailable:
    "Could not invite this address. Check the details or contact Apero for help with an existing account.",
  invite_recent: "An invitation was sent recently. Please wait before sending another.",
  rate_limited: "Please wait before sending more invitations.",
  unavailable: "Invitations are temporarily unavailable. Please try again later.",
};

export async function sendTeamInvitation(
  input:
    | { action: "invite"; fullName: string; email: string; role: "manager" | "staff" }
    | { action: "resend"; profileId: string },
) {
  const { data, error } = await db.functions.invoke("manage-clinic-users", { body: input });
  let code: unknown = data?.code;
  if (error) {
    try {
      code = (await error.context.clone().json()).code;
    } catch {
      code = "unavailable";
    }
  }
  if (error || code !== "invite_sent")
    throw new Error(
      messages[typeof code === "string" ? code : "unavailable"] ?? messages["unavailable"],
    );
}
