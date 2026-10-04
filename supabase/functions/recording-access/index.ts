import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createRecordingAccessFunction } from "./function.ts";

export default { fetch: createRecordingAccessFunction((name) => Deno.env.get(name)) };
