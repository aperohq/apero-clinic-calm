// Call deployed worker with existing backend secret. No response bodies or keys logged.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
try {
  const clinics = JSON.parse(process.env.RETENTION_CLINIC_IDS ?? "[]");
  if (!Array.isArray(clinics) || clinics.length > 100 || clinics.some((id) => !uuid.test(id)))
    throw Error();
  if (!process.env.RETENTION_WORKER_KEY) throw Error();
  for (const clinicId of clinics) {
    const r = await fetch(
      "https://svoybvzvmygszklcmudh.supabase.co/functions/v1/retention-worker",
      {
        method: "POST",
        headers: { apikey: process.env.RETENTION_WORKER_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ clinicId }),
        signal: AbortSignal.timeout(120000),
      },
    );
    if (!r.ok) throw Error();
    const result = await r.json();
    if (result.failed) throw Error();
    console.log(
      JSON.stringify({
        category: "retention_provider",
        state: "success",
        processed: Number(result.processed) || 0,
      }),
    );
  }
} catch {
  console.error(
    JSON.stringify({
      category: "retention_provider",
      state: "failure",
      failure_category: "provider_error",
    }),
  );
  process.exitCode = 1;
}
