import { createCalendarWebhook } from "./function.ts";
Deno.serve(createCalendarWebhook((name) => Deno.env.get(name)));
