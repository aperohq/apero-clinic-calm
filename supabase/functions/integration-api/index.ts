import { createIntegrationApi } from "./function.ts";
Deno.serve(createIntegrationApi((name) => Deno.env.get(name)));
