import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createDemoCallFunction } from "./function.ts";
export default { fetch: createDemoCallFunction((name) => Deno.env.get(name)) };
