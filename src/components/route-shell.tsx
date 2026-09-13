import type { ReactNode } from "react";
import { AppLayout } from "@/components/app-layout";
export function RouteShell({ children }: { children: ReactNode }) { return <AppLayout>{children}</AppLayout>; }
