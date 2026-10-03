// Deprecated for launch: use the private direct Node operator script.
// Retained for historical compatibility; no deployment is required.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createProvisionClinicUserFunction } from "./function.ts";

export default {
  fetch: createProvisionClinicUserFunction((name) => Deno.env.get(name)),
};
