// Typed view of the one shared Supabase client, using the hand-maintained
// Apero schema types (the generated types file is managed elsewhere).
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { AperoDatabase } from "./db-types";

export const db = supabase as unknown as SupabaseClient<AperoDatabase>;
