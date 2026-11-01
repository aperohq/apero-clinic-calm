import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { AudioLines, CheckCircle2, ExternalLink, Mic, MicOff, Phone, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VoiceDemoOrb } from "@/components/voice-demo-orb";
import { DemoAccess } from "@/components/demo-access";
import { useRetellDemo } from "@/hooks/use-retell-demo";

export const Route = createFileRoute("/voice-demo")({
  head: () => ({
    meta: [
      { title: "Apero | Voice Receptionist Demo" },
      { name: "robots", content: "noindex, nofollow" },
      {
        name: "description",
        content:
          "Experience the Apero clinic voice receptionist in an interactive presentation demo.",
      },
      { property: "og:title", content: "Apero | Voice Receptionist Demo" },
      {
        property: "og:description",
        content: "An interactive presentation of Apero's clinic voice receptionist.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => (
    <DemoAccess>
      <VoiceDemoPage />
    </DemoAccess>
  ),
});

function VoiceDemoPage() {
  const { state, message, cleanupPending, audioLevel, start, stop, toggleMute, resumeAudio } =
    useRetellDemo();
  const muted = state === "muted";
  const active = state === "active" || muted;
  const connecting = state === "connecting";
  const toggleCall = active || connecting ? stop : start;
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        event.code !== "Space" ||
        event.repeat ||
        (event.target instanceof HTMLElement &&
          event.target.closest("button, a, input, textarea, select, [contenteditable]"))
      )
        return;
      event.preventDefault();
      if (!cleanupPending) toggleCall();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [toggleCall, cleanupPending]);
  const title = muted
    ? "Microphone muted"
    : connecting
      ? "Connecting…"
      : state === "ready"
        ? "Ready to connect"
        : active
          ? "Call active"
          : state === "error"
            ? "Connection error"
            : "Call ended";
  const description =
    message ||
    (muted
      ? "Your microphone is muted. You can still hear Apero."
      : connecting
        ? "Allow microphone access when your browser asks."
        : state === "ready"
          ? "Start a live conversation with the Dental Zone AI receptionist. Calls may be recorded; booking requests create real appointments."
          : active
            ? "Speak in Arabic or English. The orb responds to Apero’s audio."
            : "Open the dashboard to review any appointment confirmed during the call.");
  return (
    <div className="voice-demo">
      <header className="voice-demo-header">
        <div className="flex items-center gap-3.5">
          <div className="voice-demo-emblem">
            <AudioLines aria-hidden="true" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold">apero</h1>
              <span className="voice-demo-tag">Voice AI</span>
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">AI Receptionist for Clinics</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span className="voice-demo-tag hidden sm:flex">
            <span className="voice-demo-dot" />
            Presentation demo
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Mic className="size-3.5 text-success" />
            <span>
              {active ? "Audio connected" : connecting ? "Connecting audio" : "Audio disconnected"}
            </span>
          </span>
        </div>
      </header>
      <main className="voice-demo-main">
        <div className="voice-demo-stage">
          <div className="voice-demo-ring" />
          <VoiceDemoOrb audioLevel={audioLevel} />
          {active && (
            <div className="voice-demo-waves" aria-hidden="true">
              {[1, 2, 3, 4, 5].map((n) => (
                <span key={n} />
              ))}
            </div>
          )}
        </div>
        <div className="voice-demo-status" aria-live="polite">
          <div className="voice-demo-pill">
            <span className={`voice-demo-dot ${active && !muted ? "is-active" : "is-idle"}`} />
            {title}
          </div>
          <p className="mt-3 max-w-lg text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
        <div className="mt-7 flex items-center justify-center gap-5">
          <Button
            variant="outline"
            size="icon"
            className="voice-demo-mute"
            disabled={!active}
            aria-label={muted ? "Unmute microphone" : "Mute microphone"}
            aria-pressed={muted}
            title={muted ? "Unmute microphone" : "Mute microphone"}
            onClick={toggleMute}
          >
            {muted ? <MicOff /> : <Mic />}
          </Button>
          <Button
            className="voice-demo-call"
            variant={active ? "destructive" : "default"}
            disabled={cleanupPending}
            onClick={toggleCall}
          >
            {active || connecting ? <PhoneOff /> : <Phone />}
            {connecting
              ? "Cancel"
              : active
                ? "End Call"
                : state === "ended" || state === "error"
                  ? "Start New Call"
                  : "Start Conversation"}
          </Button>
        </div>
        {active && (
          <Button variant="ghost" size="sm" onClick={resumeAudio}>
            <AudioLines />
            Enable speaker audio
          </Button>
        )}
        {cleanupPending && (
          <Button variant="outline" onClick={stop}>
            Retry cleanup
          </Button>
        )}
        <div className="voice-demo-result">
          {state === "ended" && (
            <div className="flex flex-wrap items-center justify-center gap-4">
              <CheckCircle2 className="size-7 text-success" />
              <div className="text-left">
                <p className="text-xs font-medium">Voice session ended</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Bookings and call records may appear in the clinic dashboard.
                </p>
              </div>
              <Button asChild variant="secondary" size="sm">
                <Link to="/home">
                  Open Dashboard
                  <ExternalLink />
                </Link>
              </Button>
            </div>
          )}
        </div>
      </main>
      <footer className="voice-demo-footer">
        <p>Experience the future of clinic reception.</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <span>Fluent in:</span>
          <span className="voice-demo-language" lang="ar" dir="rtl">
            العربية (Gulf &amp; MSA)
          </span>
          <span className="voice-demo-language">English</span>
        </div>
      </footer>
    </div>
  );
}
