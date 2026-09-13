import { useSyncExternalStore } from "react";
import { clients as baseClients, staff as baseStaff } from "@/lib/apero-data";

export type Client = {
  id: string; name: string; initials: string; phone: string; email: string; language: string;
  status: string; bookings: number; lastContact: string; notes?: string | undefined;
};
export type StaffMember = {
  id: string; name: string; initials: string; specialty: string; role: string; phone: string;
  email: string; services: string[]; days?: string | undefined;
};

const CLIENT_KEY = "apero.clients.v1";
const STAFF_KEY = "apero.staff.v1";
const serverClients = baseClients as Client[];
const serverStaff = baseStaff as StaffMember[];

let clientList: Client[] = serverClients;
let staffList: StaffMember[] = serverStaff;
let addedClients: Client[] = [];
let addedStaff: StaffMember[] = [];
let hydrated = false;
const listeners = new Set<() => void>();

function emit() { listeners.forEach((l) => l()); }

function load() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const c = JSON.parse(window.localStorage.getItem(CLIENT_KEY) ?? "[]");
    const s = JSON.parse(window.localStorage.getItem(STAFF_KEY) ?? "[]");
    if (Array.isArray(c) && c.length) { addedClients = c; clientList = [...c, ...serverClients]; }
    if (Array.isArray(s) && s.length) { addedStaff = s; staffList = [...s, ...serverStaff]; }
  } catch { /* ignore unreadable local data */ }
  if (addedClients.length || addedStaff.length) emit();
}

function persist() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CLIENT_KEY, JSON.stringify(addedClients));
    window.localStorage.setItem(STAFF_KEY, JSON.stringify(addedStaff));
  } catch { /* storage unavailable */ }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  load();
  return () => { listeners.delete(listener); };
}

export function initialsOf(name: string) {
  const parts = name.trim().replace(/^(dr|dr\.)\s+/i, "").split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((p) => p[0]).join("") || "?").toUpperCase();
}
function slugify(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "record";
}
function uniqueId(base: string, taken: string[]) {
  let id = base, n = 2;
  while (taken.includes(id)) { id = `${base}-${n}`; n += 1; }
  return id;
}

export function useClients() { return useSyncExternalStore(subscribe, () => clientList, () => serverClients); }
export function useStaff() { return useSyncExternalStore(subscribe, () => staffList, () => serverStaff); }

export function addClient(input: { name: string; phone: string; email?: string; notes?: string }) {
  const id = uniqueId(slugify(input.name), clientList.map((c) => c.id));
  const client: Client = {
    id, name: input.name.trim(), initials: initialsOf(input.name), phone: input.phone.trim(),
    email: input.email?.trim() || "—", language: "English", status: "New Client", bookings: 0,
    lastContact: "Just now", notes: input.notes?.trim() || undefined,
  };
  addedClients = [client, ...addedClients];
  clientList = [client, ...clientList];
  persist(); emit();
  return client;
}

export function addStaffMember(input: { name: string; specialty: string; phone?: string; email?: string; services?: string; days?: string }) {
  const id = uniqueId(slugify(input.name), staffList.map((s) => s.id));
  const member: StaffMember = {
    id, name: input.name.trim(), initials: initialsOf(input.name), specialty: input.specialty.trim(),
    role: input.specialty.trim(), phone: input.phone?.trim() || "—", email: input.email?.trim() || "—",
    services: (input.services ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    days: input.days?.trim() || "Mon–Thu",
  };
  addedStaff = [member, ...addedStaff];
  staffList = [member, ...staffList];
  persist(); emit();
  return member;
}
