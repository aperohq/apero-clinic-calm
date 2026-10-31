import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AudioLines, CheckCircle2, ExternalLink, Mic, MicOff, Phone, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VoiceDemoOrb } from "@/components/voice-demo-orb";

export const Route = createFileRoute("/voice-demo")({
  head: () => ({ meta: [
    { title: "Apero | Voice Receptionist Demo" },
    { name: "description", content: "Experience the Apero clinic voice receptionist in an interactive presentation demo." },
    { property: "og:title", content: "Apero | Voice Receptionist Demo" },
    { property: "og:description", content: "An interactive presentation of Apero's clinic voice receptionist." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary_large_image" },
  ] }),
  component: VoiceDemoPage,
});

function VoiceDemoPage() {
  const [state, setState] = useState<"ready" | "speaking" | "listening" | "ended">("ready");
  const [muted, setMuted] = useState(false);
  const active = state === "speaking" || state === "listening";
  const toggleCall = () => { setState(active ? "ended" : "speaking"); setMuted(false); };
  useEffect(() => {
    if (state !== "speaking" || muted) return;
    const timer = window.setTimeout(() => setState("listening"), 4500);
    return () => window.clearTimeout(timer);
  }, [state, muted]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || (event.target instanceof HTMLElement && event.target.closest("button, a, input, textarea, select, [contenteditable]"))) return;
      event.preventDefault();
      setState(s => s === "ready" || s === "ended" ? "speaking" : "ended");
      setMuted(false);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
  const title = muted ? "Microphone muted" : state === "ready" ? "Ready to connect" : state === "speaking" ? "Apero is speaking…" : state === "listening" ? "Listening…" : "Call ended";
  const description = muted ? "Your microphone is muted in this demo." : state === "ready" ? "Begin a simulated clinic voice conversation." : state === "speaking" ? "“Welcome to Dental Zone Clinic. How can I help you today?”" : state === "listening" ? "Your turn — this presentation does not capture microphone audio." : "Demo complete. No appointment was created.";
  return <div className="voice-demo">
    <header className="voice-demo-header">
      <div className="flex items-center gap-3.5">
        <div className="voice-demo-emblem"><AudioLines aria-hidden="true" /></div>
        <div><div className="flex items-center gap-2"><h1 className="text-lg font-semibold">apero</h1><span className="voice-demo-tag">Voice AI</span></div><p className="mt-0.5 text-[11px] text-muted-foreground">AI Receptionist for Clinics</p></div>
      </div>
      <div className="flex items-center gap-4"><span className="voice-demo-tag hidden sm:flex"><span className="voice-demo-dot" />Presentation demo</span><span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Mic className="size-3.5 text-success" /><span>No audio connected</span></span></div>
    </header>
    <main className="voice-demo-main">
      <div className="voice-demo-stage"><div className="voice-demo-ring" /><VoiceDemoOrb />{active && !muted && <div className="voice-demo-waves" aria-hidden="true">{[1, 2, 3, 4, 5].map(n => <span key={n} />)}</div>}</div>
      <div className="voice-demo-status" aria-live="polite"><div className="voice-demo-pill"><span className={`voice-demo-dot ${active && !muted ? "is-active" : "is-idle"}`} />{title}</div><p className="mt-3 max-w-lg text-sm leading-6 text-muted-foreground">{description}</p></div>
      <div className="mt-7 flex items-center justify-center gap-5"><Button variant="outline" size="icon" className="voice-demo-mute" disabled={!active} aria-label={muted ? "Unmute microphone" : "Mute microphone"} aria-pressed={muted} title={muted ? "Unmute microphone" : "Mute microphone"} onClick={() => setMuted(m => !m)}>{muted ? <MicOff /> : <Mic />}</Button><Button className="voice-demo-call" variant={active ? "destructive" : "default"} onClick={toggleCall}>{active ? <PhoneOff /> : <Phone />}{active ? "End Call" : state === "ended" ? "Start New Call" : "Start Conversation"}</Button></div>
      <div className="voice-demo-result">{state === "ended" && <div className="flex flex-wrap items-center justify-center gap-4"><CheckCircle2 className="size-7 text-success" /><div className="text-left"><p className="text-xs font-medium">Conversation demo completed</p><p className="mt-1 text-[11px] text-muted-foreground">No call recording or clinic data was saved.</p></div><Button asChild variant="secondary" size="sm"><Link to="/home">Open Dashboard<ExternalLink /></Link></Button></div>}</div>
    </main>
    <footer className="voice-demo-footer"><p>Experience the future of clinic reception.</p><div className="flex flex-wrap items-center justify-center gap-2"><span>Fluent in:</span><span className="voice-demo-language" lang="ar" dir="rtl">العربية (Gulf &amp; MSA)</span><span className="voice-demo-language">English</span></div></footer>
  </div>;
}