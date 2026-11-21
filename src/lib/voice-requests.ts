import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import type { VoiceRequestRow } from "@/lib/db-types";

const fields = "id,clinic_id,kind,caller_name,patient_name,phone,reason,status,created_at";
export type VoiceRequestDisplay = Pick<
  VoiceRequestRow,
  | "id"
  | "clinic_id"
  | "kind"
  | "caller_name"
  | "patient_name"
  | "phone"
  | "reason"
  | "status"
  | "created_at"
>;

export function useVoiceRequests() {
  const { profile, clinicId } = useAuth();
  const authorized = hasPermission(profile?.role ?? null, "requests.manage");
  return useQuery({
    queryKey: ["voice_requests", clinicId],
    enabled: !!clinicId && authorized,
    queryFn: async () => {
      if (!clinicId) throw new Error("Clinic unavailable");
      const rows: VoiceRequestDisplay[] = [];
      // Page through PostgREST so a clinic with many requests does not silently lose older rows.
      for (let start = 0; ; start += 500) {
        const { data, error } = await db
          .from("voice_requests")
          .select(fields)
          .eq("clinic_id", clinicId)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(start, start + 499);
        if (error) throw error;
        rows.push(...((data ?? []) as VoiceRequestDisplay[]));
        if (!data || data.length < 500) break;
      }
      return rows;
    },
  });
}

export function useCloseVoiceRequest() {
  const { profile, clinicId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!clinicId || !hasPermission(profile?.role ?? null, "requests.manage"))
        throw new Error("Not authorized");
      const { data, error } = await db
        .from("voice_requests")
        .update({ status: "Closed" })
        .eq("id", id)
        .eq("clinic_id", clinicId)
        .neq("status", "Closed")
        .select("id")
        .single();
      if (error || !data) throw new Error("Could not mark this request handled.");
      const { data: saved, error: readError } = await db
        .from("voice_requests")
        .select("status")
        .eq("id", id)
        .eq("clinic_id", clinicId)
        .single();
      if (readError || saved?.status !== "Closed")
        throw new Error("The change could not be verified.");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["voice_requests", clinicId] }),
  });
}
