import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { loadClinicReadiness } from "@/lib/clinic-readiness";
import { Panel, PanelTitle } from "@/components/page-ui";
import { Button } from "@/components/ui/button";

const stateLabels = {
  onboarding_incomplete: "Onboarding incomplete",
  configuration_complete: "Configuration complete",
  technically_activation_ready: "Technically activation-ready",
  awaiting_external_dependencies: "Awaiting external dependencies",
  activated: "Activated",
};

export function ClinicReadinessPanel() {
  const { role, clinicId, profile } = useAuth();
  if (role !== "owner" || !clinicId || !profile || profile.revoked_at !== null) return null;
  return <OwnerReadiness clinicId={clinicId} profileId={profile.id} />;
}

function OwnerReadiness({ clinicId, profileId }: { clinicId: string; profileId: string }) {
  const readiness = useQuery({
    queryKey: ["clinic_activation_readiness", clinicId, profileId],
    queryFn: () => loadClinicReadiness(clinicId),
    retry: false,
    refetchInterval: 60_000,
  });
  return (
    <Panel>
      <div className="min-w-0 break-words">
        <PanelTitle>Clinic activation readiness</PanelTitle>
        {readiness.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Checking clinic configuration…
          </p>
        ) : readiness.isError ? (
          <div role="alert" className="space-y-3 text-sm">
            <p>
              Clinic readiness could not be verified. No readiness or activation decision is
              confirmed. Contact Apero if this continues.
            </p>
            <Button variant="outline" onClick={() => void readiness.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p role="status" className="font-medium">
                {stateLabels[readiness.data.state]}
              </p>
              <Button
                variant="outline"
                disabled={readiness.isFetching}
                onClick={() => void readiness.refetch()}
              >
                {readiness.isFetching ? "Checking…" : "Check again"}
              </Button>
            </div>
            {readiness.data.failures.length > 0 && (
              <div>
                <p className="mb-2 font-medium">Required configuration</p>
                <ul className="list-disc space-y-2 pl-5">
                  {readiness.data.failures.map((failure, index) => (
                    <li key={index}>{failure}</li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <p className="mb-2 font-medium">External verification</p>
              <ul className="space-y-2">
                {readiness.data.external_dependencies.map((dependency, index) => (
                  <li
                    key={index}
                    className="flex flex-wrap justify-between gap-x-4 gap-y-1 rounded-md border p-3"
                  >
                    <span>{dependency.name}</span>
                    <span className="text-muted-foreground">{dependency.status}</span>
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-muted-foreground">
              Technical readiness does not activate your clinic. Activation requires a separate
              authorized release decision after external verification and clinic acceptance.
            </p>
          </div>
        )}
      </div>
    </Panel>
  );
}
