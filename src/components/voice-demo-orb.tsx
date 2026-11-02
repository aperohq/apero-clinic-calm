import type { DemoState } from "@/lib/demo-call";

export function VoiceDemoOrb({ state }: { state: DemoState }) {
  return (
    <div className="demo-orb-stage" data-state={state} aria-hidden="true">
      <div className="demo-orb-halo" />
      <div className="demo-orb-ring" />
      <div className="demo-orb">
        <div className="demo-orb-light" />
        <div className="demo-orb-wave" />
      </div>
    </div>
  );
}
