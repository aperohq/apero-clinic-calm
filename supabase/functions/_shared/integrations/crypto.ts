const encoder = new TextEncoder();
export async function sha256(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function randomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export async function challenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
}
async function encryptionKey(secret: string) {
  // Explicit 256-bit random hex key, independent of Supabase and OAuth secrets.
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error("encryption_not_configured");
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(secret.match(/../g)!, (x) => parseInt(x, 16)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
export async function seal(value: unknown, secret: string, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
      await encryptionKey(secret),
      encoder.encode(JSON.stringify(value)),
    ),
  );
  return `v1.${base64url(iv)}.${base64url(data)}`;
}
export async function unseal<T>(value: string, secret: string, context: string): Promise<T> {
  const [version, iv, data] = value.split(".");
  if (version !== "v1" || !iv || !data) throw new Error("invalid_ciphertext");
  const decode = (s: string) =>
    Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  return JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: decode(iv), additionalData: encoder.encode(context) },
        await encryptionKey(secret),
        decode(data),
      ),
    ),
  ) as T;
}
export async function equalSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
