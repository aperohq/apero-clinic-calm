import type { ProfileRole } from "./db-types";

export const ROLE_LABELS: Record<ProfileRole, string> = {
  owner: "Owner",
  manager: "Admin / Manager",
  staff: "Staff",
};

const permissions = {
  operations: ["owner", "manager", "staff"],
  "clients.create": ["owner", "manager"],
  "staff.manage": ["owner", "manager"],
  "requests.manage": ["owner", "manager"],
  "analytics.view": ["owner", "manager"],
  "accounts.view": ["owner", "manager"],
  "accounts.manage": ["owner"],
  "clinic.configure": ["owner"],
  "integrations.configure": ["owner"],
  "billing.view": ["owner"],
  "ownership.manage": ["owner"],
} as const;
export type Permission = keyof typeof permissions;

// Presentation only. Database RLS/RPCs remain the authorization boundary.
export function hasPermission(role: ProfileRole | null, permission: Permission): boolean {
  return !!role && (permissions[permission] as readonly string[]).includes(role);
}

const routes: Record<string, Permission> = {
  "/home": "operations",
  "/calendar": "operations",
  "/clients": "operations",
  "/conversations": "operations",
  "/support": "operations",
  "/account": "operations",
  "/staff": "staff.manage",
  "/requests": "requests.manage",
  // Reserved access rules; these modules are not implemented by this milestone.
  "/account/billing": "billing.view",
  "/account/ownership": "ownership.manage",
  "/account/settings": "clinic.configure",
  "/account/integrations": "integrations.configure",
  "/account/team": "accounts.view",
  "/analytics": "analytics.view",
};
export function canAccess(role: ProfileRole | null, path: string): boolean {
  const base = Object.keys(routes)
    .sort((a, b) => b.length - a.length)
    .find((route) => path === route || (route !== "/account" && path.startsWith(route + "/")));
  return !!base && hasPermission(role, routes[base]!);
}
