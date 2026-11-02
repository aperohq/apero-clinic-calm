import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpRight, Headphones, Mic, PhoneOff, Volume2 } from "lucide-react";
import { DemoAccess } from "@/components/demo-access";
import { VoiceDemoOrb } from "@/components/voice-demo-orb";
import { useRetellDemo } from "@/hooks/use-retell-demo";
import "@/voice-demo.css";

export const Route = createFileRoute("/voice-demo")({
  head: () => ({
    meta: [
      { title: "Meet your AI receptionist · Apero" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: () => (
    <DemoAccess>
      <VoiceDemo />
    </DemoAccess>
  ),
});

function VoiceDemo() {
  const demo = useRetellDemo();
  const active = ["listening", "speaking"].includes(demo.state);
  const busy = ["permission", "connecting", "ending"].includes(demo.state);
  const labels = {
    ready: "Ready when you are",
    permission: "Allow your microphone",
    connecting: "Connecting you…",
    listening: "Listening to you",
    speaking: "Your receptionist is speaking",
    ending: "Ending your conversation…",
    ended: "Thanks for stopping by",
    error: "Let’s try that again",
  };
  return (
    <main className="voice-demo">
      <header className="demo-header">
        <a href="/" aria-label="Apero home" className="demo-brand">
          <img src="/apero-logo-black.png" alt="" width="34" height="34" />
          <span>
            apero<span className="demo-brand-dot">.</span>
          </span>
        </a>
        <span className="demo-header-note">
          A better first hello <ArrowUpRight size={14} />
        </span>
      </header>
      <section className="demo-experience">
        <div className="demo-eyebrow">
          <span /> THE APERO EXPERIENCE
        </div>
        <h1>
          A warm welcome.
          <br />
          <span>Every single time.</span>
        </h1>
        <p className="demo-intro">
          Meet the AI receptionist that makes every patient feel heard.
          <br className="hidden sm:block" /> Ask a question. Find a time. Experience the
          conversation.
        </p>
        <VoiceDemoOrb state={demo.state} />
        <div className="demo-status" role="status" aria-live="polite">
          <span className={active ? "demo-live-dot" : "demo-idle-dot"} />
          {labels[demo.state]}
        </div>
        <p className="demo-status-detail">
          {demo.state === "permission"
            ? "Choose Allow when your browser asks for microphone access."
            : active
              ? "Speak naturally in English or Arabic. We’re here to help."
              : demo.state === "ended"
                ? "You can start another conversation whenever you’re ready."
                : "Your microphone turns on only when you start."}
        </p>
        {demo.message && (
          <p className="demo-error" role="alert">
            {demo.message}
          </p>
        )}
        <div className="demo-controls">
          {active || busy ? (
            <button
              className="demo-primary demo-end"
              onClick={demo.stop}
              disabled={demo.state === "ending"}
            >
              <PhoneOff size={17} />
              {demo.state === "ending" ? "Ending…" : "End call"}
            </button>
          ) : demo.cleanupPending ? (
            <button className="demo-primary" onClick={demo.stop}>
              <PhoneOff size={17} />
              Retry ending session
            </button>
          ) : (
            <button className="demo-primary" onClick={demo.start}>
              <Mic size={18} />
              {demo.state === "ready" ? "Start Demo" : "Try again"}
            </button>
          )}
          {active && (
            <button className="demo-audio" onClick={demo.resumeAudio}>
              <Volume2 size={16} />
              Enable audio
            </button>
          )}
        </div>
        <p className="demo-audio-note">
          <Headphones size={14} />
          For the best experience, use headphones
        </p>
      </section>
      <footer className="demo-footer">
        <span>Thoughtfully built for better patient experiences.</span>
        <span>English & العربية</span>
      </footer>
    </main>
  );
}
