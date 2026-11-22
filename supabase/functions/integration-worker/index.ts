import { createIntegrationDrain } from "./function.ts";
Deno.serve(createIntegrationDrain((name) => Deno.env.get(name)));
