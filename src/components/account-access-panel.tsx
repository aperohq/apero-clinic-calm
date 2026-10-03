import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { hasPermission, ROLE_LABELS } from "@/lib/permissions";
import { loadTeam, sendTeamInvitation } from "@/lib/team-management";
import type { TeamMemberRow } from "@/lib/db-types";
import { Empty, Panel, PanelTitle } from "@/components/page-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";

const statuses = {
  active: "Active account",
  pending: "Invitation pending",
  accepted: "Invite accepted",
  revoked: "Access revoked",
};

export function AccountAccessPanel() {
  const { role, clinicId, profile } = useAuth();
  const queryClient = useQueryClient();
  const canView = hasPermission(role, "accounts.view");
  const canManage = hasPermission(role, "accounts.manage");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"manager" | "staff">("staff");
  const [inviteError, setInviteError] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<TeamMemberRow | null>(null);
  const [revokeError, setRevokeError] = useState("");
  const members = useQuery({
    queryKey: ["clinic_accounts", clinicId, role],
    enabled: !!clinicId && canView,
    refetchInterval: 30_000,
    queryFn: loadTeam,
  });
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["clinic_accounts", clinicId] });
  const change = useMutation({
    mutationFn: async ({ id, next }: { id: string; next: "manager" | "staff" }) => {
      if (!clinicId || !canManage) throw new Error("Not authorized.");
      const { data, error } = await db.rpc("set_clinic_member_role", {
        p_profile_id: id,
        p_role: next,
      });
      if (error || data !== id) throw new Error("Could not change account access.");
      const { data: saved, error: readError } = await db
        .from("profiles")
        .select("role")
        .eq("id", id)
        .eq("clinic_id", clinicId)
        .single();
      if (readError || saved?.role !== next) throw new Error("Could not verify account access.");
    },
    onSuccess: async () => {
      await invalidate();
      toast.success("Account access updated");
    },
    onError: () => toast.error("Could not change account access. Refresh and try again."),
  });
  const invite = useMutation({
    mutationFn: async (input: Parameters<typeof sendTeamInvitation>[0]) => {
      if (!clinicId || !canManage) throw new Error("Only clinic Owners can invite users.");
      await sendTeamInvitation(input);
    },
    onSuccess: async () => {
      await invalidate();
      toast.success("Invitation email sent");
    },
    // Also refresh after email failure: the verified profile may already exist.
    onError: async () => {
      await invalidate();
    },
  });
  const revoke = useMutation({
    mutationFn: async (target: TeamMemberRow) => {
      if (!canManage || !clinicId || target.role === "owner" || target.id === profile?.id)
        throw new Error("Not authorized.");
      const { data, error } = await db.rpc("revoke_clinic_member", { p_profile_id: target.id });
      if (error || data !== target.id)
        throw new Error("Could not revoke clinic access. Refresh and try again.");
      const { data: saved, error: readError } = await db
        .from("profiles")
        .select("revoked_at")
        .eq("id", target.id)
        .eq("clinic_id", clinicId)
        .single();
      if (readError || !saved?.revoked_at)
        throw new Error("Could not verify access revocation. Refresh the team.");
    },
    onSuccess: async () => {
      await invalidate();
      toast.success("Clinic access revoked");
      setRevokeTarget(null);
    },
  });
  const busy = change.isPending || invite.isPending || revoke.isPending;
  if (!canView || !clinicId) return null;
  return (
    <>
      <Panel>
        <PanelTitle
          detail={
            canManage ? (
              <Button
                disabled={busy}
                onClick={() => {
                  setName("");
                  setEmail("");
                  setInviteRole("staff");
                  setInviteError("");
                  setInviteOpen(true);
                }}
              >
                Invite user
              </Button>
            ) : null
          }
        >
          Clinic account access
        </PanelTitle>
        <p className="mb-4 text-sm text-muted-foreground">
          {canManage
            ? "Manage portal access for your clinic. Owner accounts cannot be changed or removed."
            : "Only clinic owners can change account permissions or invite and revoke users."}{" "}
          Portal accounts are separate from practitioner records and schedules.
        </p>
        {members.isPending ? (
          <p role="status">Loading clinic accounts…</p>
        ) : members.isError ? (
          <div role="alert">
            Could not load clinic accounts.{" "}
            <Button variant="outline" onClick={() => void members.refetch()}>
              Try again
            </Button>
          </div>
        ) : !members.data.length ? (
          <Empty>No portal accounts found.</Empty>
        ) : (
          <ul className="space-y-3">
            {members.data.map((member) => {
              const editable =
                canManage &&
                member.role !== "owner" &&
                member.id !== profile?.id &&
                !member.revoked_at;
              return (
                <li
                  key={member.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3"
                >
                  <div className="min-w-0">
                    <p className="break-words font-medium">
                      {member.full_name}
                      {member.id === profile?.id ? " (you)" : ""}
                    </p>
                    <p className="break-all text-xs text-muted-foreground">{member.email}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {statuses[member.invite_status]}
                    </p>
                    {member.invite_status === "pending" && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        If the link has expired, resend the invitation.
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {editable ? (
                      <label className="text-xs text-muted-foreground">
                        Access for {member.full_name}
                        <select
                          aria-label={`Access for ${member.full_name}`}
                          value={member.role}
                          disabled={busy}
                          className="ml-2 rounded-md border border-input bg-background p-2 text-sm text-foreground"
                          onChange={(event) => {
                            const next = event.target.value;
                            if (next === "manager" || next === "staff")
                              change.mutate({ id: member.id, next });
                          }}
                        >
                          <option value="staff">Staff</option>
                          <option value="manager">Admin / Manager</option>
                        </select>
                      </label>
                    ) : (
                      <span className="text-sm">{ROLE_LABELS[member.role]}</span>
                    )}
                    {editable && member.invite_status === "pending" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={async () => {
                          try {
                            await invite.mutateAsync({ action: "resend", profileId: member.id });
                          } catch (error) {
                            toast.error(
                              error instanceof Error
                                ? error.message
                                : "Could not resend the invitation.",
                            );
                          }
                        }}
                      >
                        Resend invitation
                      </Button>
                    )}
                    {editable && (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        aria-label={`Revoke access for ${member.full_name}`}
                        onClick={() => {
                          setRevokeError("");
                          setRevokeTarget(member);
                        }}
                      >
                        Revoke access
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      <Dialog
        open={inviteOpen && canManage}
        onOpenChange={(open) => {
          if (!invite.isPending) setInviteOpen(open);
        }}
      >
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>Invite portal user</DialogTitle>
            <DialogDescription>
              Send an email invitation to join your clinic. This does not create a practitioner.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy) return;
              setInviteError("");
              try {
                await invite.mutateAsync({
                  action: "invite",
                  fullName: name.trim(),
                  email: email.trim(),
                  role: inviteRole,
                });
                setInviteOpen(false);
              } catch (error) {
                setInviteError(
                  error instanceof Error ? error.message : "Could not send the invitation.",
                );
              }
            }}
          >
            {inviteError && (
              <p role="alert" className="text-sm text-destructive">
                {inviteError}
              </p>
            )}
            <div>
              <Label htmlFor="team-invite-name">Full name</Label>
              <Input
                id="team-invite-name"
                required
                maxLength={200}
                disabled={invite.isPending}
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="mt-2"
              />
            </div>
            <div>
              <Label htmlFor="team-invite-email">Email address</Label>
              <Input
                id="team-invite-email"
                type="email"
                required
                maxLength={254}
                disabled={invite.isPending}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="mt-2"
              />
            </div>
            <div>
              <Label htmlFor="team-invite-role">Portal role</Label>
              <select
                id="team-invite-role"
                className="mt-2 w-full rounded-md border border-input bg-background p-2 text-sm"
                value={inviteRole}
                disabled={invite.isPending}
                onChange={(event) => {
                  if (event.target.value === "manager" || event.target.value === "staff")
                    setInviteRole(event.target.value);
                }}
              >
                <option value="staff">Staff</option>
                <option value="manager">Admin / Manager</option>
              </select>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={invite.isPending}
                onClick={() => setInviteOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {invite.isPending ? "Sending…" : "Send invitation"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!revokeTarget && canManage}
        onOpenChange={(open) => {
          if (!open && !revoke.isPending) setRevokeTarget(null);
        }}
      >
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>Revoke clinic access?</DialogTitle>
            <DialogDescription>
              {revokeTarget?.full_name} ({revokeTarget?.email}) will immediately lose access to this
              clinic, including with an existing session. Their account and historical actions will
              be preserved. Practitioner records and schedules are unchanged.
            </DialogDescription>
          </DialogHeader>
          {revokeError && (
            <p role="alert" className="text-sm text-destructive">
              {revokeError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={revoke.isPending}
              onClick={() => setRevokeTarget(null)}
            >
              Keep access
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (!revokeTarget || busy) return;
                setRevokeError("");
                try {
                  await revoke.mutateAsync(revokeTarget);
                } catch (error) {
                  setRevokeError(
                    error instanceof Error ? error.message : "Could not revoke access.",
                  );
                }
              }}
            >
              {revoke.isPending ? "Revoking…" : "Confirm revocation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
