import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { hasPermission, ROLE_LABELS } from "@/lib/permissions";
import { Panel, PanelTitle } from "@/components/page-ui";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function AccountAccessPanel() {
  const { role, clinicId } = useAuth();
  const queryClient = useQueryClient();
  const canView = hasPermission(role, "accounts.view");
  const canManage = hasPermission(role, "accounts.manage");
  const queryKey = ["clinic_accounts", clinicId, role];
  const members = useQuery({
    queryKey,
    enabled: !!clinicId && canView,
    queryFn: async () => {
      const { data, error } = await db
        .from("profiles")
        .select("id,full_name,email,role")
        .eq("clinic_id", clinicId!)
        .order("full_name");
      if (error) throw new Error("Could not load clinic accounts.");
      return data ?? [];
    },
  });
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
      await queryClient.invalidateQueries({ queryKey: ["clinic_accounts", clinicId] });
      toast.success("Account access updated");
    },
    onError: () => toast.error("Could not change account access. Refresh and try again."),
  });
  if (!canView || !clinicId) return null;
  return (
    <Panel>
      <PanelTitle>Clinic account access</PanelTitle>
      <p className="mb-4 text-sm text-muted-foreground">
        {canManage
          ? "Assign Admin / Manager or Staff access to existing clinic members. Owner access is managed through Apero."
          : "Only clinic owners can change account permissions."}{" "}
        Contact Apero to invite another user.
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
      ) : (
        <ul className="space-y-3">
          {members.data.map((member) => (
            <li
              key={member.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3"
            >
              <div className="min-w-0">
                <p className="break-words font-medium">{member.full_name}</p>
                <p className="break-all text-xs text-muted-foreground">{member.email}</p>
              </div>
              {canManage && member.role !== "owner" ? (
                <label className="text-xs text-muted-foreground">
                  Access for {member.full_name}
                  <select
                    aria-label={`Access for ${member.full_name}`}
                    value={member.role}
                    disabled={change.isPending}
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
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
