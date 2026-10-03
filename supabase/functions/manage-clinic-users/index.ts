import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createTeamFunction } from "./function.ts";

export default { fetch: createTeamFunction((name) => Deno.env.get(name)) };
