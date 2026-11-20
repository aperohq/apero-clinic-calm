import { createDemoCallFunction } from "./function.ts";
Deno.serve(createDemoCallFunction((name) => Deno.env.get(name)));
