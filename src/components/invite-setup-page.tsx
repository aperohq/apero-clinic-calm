import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { AperoMark } from "@/components/apero-brand";
import { Panel } from "@/components/page-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";

export function InviteSetupPage() {
  const { loading, session, updatePassword } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || loading || !session) return;
    setError("");
    if (password.length < 8 || !/[A-Z]/.test(password) || !/\d/.test(password)) {
      setError("Use at least 8 characters, including an uppercase letter and a number.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      // Existing Auth context calls authenticated supabase.auth.updateUser.
      // No profile/clinic/role fields are written here.
      const result = await updatePassword(password);
      if (result.error) {
        setError(
          "Could not create your password. Please try again, or ask your clinic Owner for a new invitation if this one has expired.",
        );
        return;
      }
      setPassword("");
      setConfirm("");
      await navigate({ to: "/home", replace: true });
    } catch {
      setError(
        "Could not create your password. Please try again, or ask your clinic Owner for a new invitation if this one has expired.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background p-4">
      <div className="w-full max-w-[430px]">
        <div className="mb-8 flex justify-center">
          <AperoMark />
        </div>
        <Panel className="p-7 sm:p-9">
          <h1 className="text-2xl font-semibold">Complete your account</h1>
          {loading ? (
            <p role="status" className="mt-2 text-sm text-muted-foreground">
              Checking your invitation…
            </p>
          ) : !session ? (
            <p role="alert" className="mt-2 text-sm text-muted-foreground">
              This invitation is invalid or has expired. Ask your clinic Owner for a new invitation,
              or return to sign in.
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm text-muted-foreground">
                Create a password to access your clinic workspace.
              </p>
              {error && (
                <div
                  role="alert"
                  className="mt-5 rounded-[10px] border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
                >
                  {error}
                </div>
              )}
              <form className="mt-7 space-y-4" onSubmit={(event) => void submit(event)}>
                <div>
                  <Label htmlFor="setup-password">Create password</Label>
                  <Input
                    id="setup-password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    required
                    disabled={busy}
                    className="mt-2 h-10 rounded-[10px]"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    aria-describedby="setup-password-rules"
                  />
                  <p id="setup-password-rules" className="mt-2 text-xs text-muted-foreground">
                    At least 8 characters, including an uppercase letter and a number.
                  </p>
                </div>
                <div>
                  <Label htmlFor="setup-confirm-password">Confirm password</Label>
                  <Input
                    id="setup-confirm-password"
                    name="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    required
                    disabled={busy}
                    className="mt-2 h-10 rounded-[10px]"
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                  />
                </div>
                <Button type="submit" disabled={busy} className="h-10 w-full rounded-[10px]">
                  {busy ? "Creating password…" : "Create password"}
                </Button>
              </form>
            </>
          )}
          {!loading && (
            <Button variant="ghost" className="mt-4" asChild>
              <Link to="/login">Back to sign in</Link>
            </Button>
          )}
        </Panel>
      </div>
    </main>
  );
}
