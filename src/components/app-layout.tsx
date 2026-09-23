import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { CalendarDays, Headphones, Home, Inbox, LogOut, Menu, MessageSquare, PanelLeftClose, PanelLeftOpen, UserRound, Users, X } from "lucide-react";
import { AperoMark, ClinicBadge } from "@/components/apero-brand";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const main = [
  { to: "/home", label: "Home", icon: Home },
  { to: "/calendar", label: "Calendar", icon: CalendarDays },
  { to: "/clients", label: "Clients", icon: Users },
  { to: "/staff", label: "Staff", icon: UserRound },
  { to: "/conversations", label: "Conversations", icon: MessageSquare },
  { to: "/requests", label: "Requests", icon: Inbox },
] as const;
const footer = [{ to: "/support", label: "Support", icon: Headphones }, { to: "/account", label: "Account", icon: UserRound }] as const;

type NavItem = { to: string; label: string; icon: typeof Home };

function Nav({ compact, onSelect }: { compact?: boolean; onSelect?: () => void }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const { role, signOut } = useAuth();
  const allowed = (item: NavItem) => {
    if (item.to === "/staff") return role !== "staff";
    if (item.to === "/requests") return role === "owner" || role === "manager";
    return true;
  };
  const row = (item: NavItem) => {
    const active = path === item.to || (item.to !== "/home" && path.startsWith(item.to + "/"));
    return <Link key={item.to} to={item.to} onClick={onSelect} title={compact ? item.label : undefined} className={cn("flex h-10 items-center gap-3 rounded-[10px] px-3 text-sm font-medium transition-colors", active ? "bg-nav-active text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground", compact && "justify-center px-0")}><item.icon className="size-4" />{!compact && <span>{item.label}</span>}{active && !compact && <span className="ml-auto size-1.5 rounded-full bg-success" />}</Link>;
  };
  const operations = main.slice(1).filter(allowed);
  return <><div className="space-y-1">{row(main[0])}</div>{!compact && <p className="mb-2 mt-6 px-3 text-[10px] font-semibold uppercase text-muted-foreground">Operations</p>}<div className={cn("space-y-1", compact && "mt-3")}>{operations.map(row)}</div><div className="mt-auto space-y-1 border-t border-border pt-3">{footer.map(row)}<button type="button" onClick={async () => { const { error } = await signOut(); if (error) { toast.error(error); return; } onSelect?.(); void navigate({ to: "/login" }); }} className={cn("flex h-10 w-full items-center gap-3 rounded-[10px] px-3 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground", compact && "justify-center px-0")} aria-label="Log out"><LogOut className="size-4" />{!compact && "Log out"}</button></div></>;
}

export function AppLayout({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const { clinic } = useAuth();
  return <div className="min-h-screen bg-background text-foreground">
    <aside className={cn("fixed inset-y-0 left-0 z-30 hidden border-r border-border bg-sidebar px-3 py-5 transition-[width] lg:flex lg:flex-col", collapsed ? "w-16" : "w-[260px]")}>
      <div className={cn("mb-7 flex items-center", collapsed ? "justify-center" : "justify-between px-2")}><AperoMark compact={collapsed} /><Button variant="ghost" size="icon" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>{collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</Button></div>
      <div className="mb-6 rounded-xl border border-border bg-card p-2"><ClinicBadge compact={collapsed} name={clinic?.name} /></div><Nav compact={collapsed} />
    </aside>
    <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-border bg-card/95 px-4 backdrop-blur lg:hidden"><AperoMark /><Button variant="ghost" size="icon" onClick={() => setMobile(true)} aria-label="Open menu"><Menu /></Button></header>
    {mobile && <div className="fixed inset-0 z-50 lg:hidden"><div className="absolute inset-0 bg-overlay" onClick={() => setMobile(false)} /><aside className="absolute inset-y-0 left-0 flex w-[min(280px,100vw)] flex-col overflow-y-auto bg-sidebar p-4 shadow-modal"><div className="mb-6 flex items-center justify-between"><AperoMark /><Button variant="ghost" size="icon" onClick={() => setMobile(false)} aria-label="Close menu"><X /></Button></div><div className="mb-6 rounded-xl border border-border bg-card p-2"><ClinicBadge name={clinic?.name} /></div><Nav onSelect={() => setMobile(false)} /></aside></div>}
    <main className={cn("min-h-screen transition-[margin]", collapsed ? "lg:ml-16" : "lg:ml-[260px]")}><div className="mx-auto max-w-[1600px] p-4 sm:p-6 lg:p-8">{children}</div></main>
  </div>;
}
