import type { DocJSON } from "../shared/model.ts";
import type { SheetMeta, SheetSummary, User, VersionInfo } from "../shared/protocol.ts";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown, type = "application/json"): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { "content-type": type },
      body: body === undefined ? undefined : type === "application/json" ? JSON.stringify(body) : (body as BodyInit),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "Could not reach the server. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed with status ${res.status}`);
  return data as T;
}

export const api = {
  me: () => call<{ user: User | null }>("GET", "/api/auth/me"),
  guest: () => call<{ user: User }>("POST", "/api/auth/guest", {}),
  login: (email: string, password: string) => call<{ user: User }>("POST", "/api/auth/login", { email, password }),
  signup: (name: string, email: string, password: string) => call<{ user: User }>("POST", "/api/auth/signup", { name, email, password }),
  logout: () => call<{ ok: true }>("POST", "/api/auth/logout", {}),
  sheets: () => call<{ sheets: SheetSummary[] }>("GET", "/api/sheets"),
  create: (template: "blank" | "demo" = "blank") => call<{ id: string }>("POST", "/api/sheets", { template }),
  importCsv: (file: File) => call<{ id: string }>("POST", `/api/sheets/import?name=${encodeURIComponent(file.name)}`, file, "text/csv"),
  sheet: (id: string) => call<SheetMeta>("GET", `/api/sheets/${id}`),
  setLinkAccess: (id: string, linkAccess: SheetMeta["linkAccess"]) => call<SheetMeta>("PATCH", `/api/sheets/${id}`, { linkAccess }),
  remove: (id: string) => call<{ ok: true }>("DELETE", `/api/sheets/${id}`),
  addMember: (id: string, email: string, role: "editor" | "viewer") => call<SheetMeta>("POST", `/api/sheets/${id}/members`, { email, role }),
  removeMember: (id: string, userId: string) => call<SheetMeta>("DELETE", `/api/sheets/${id}/members/${userId}`),
  copy: (id: string) => call<{ id: string }>("POST", `/api/sheets/${id}/copy`, {}),
  versions: (id: string) => call<{ versions: VersionInfo[] }>("GET", `/api/sheets/${id}/versions`),
  version: (id: string, vid: number) => call<{ seq: number; state: DocJSON }>("GET", `/api/sheets/${id}/versions/${vid}`),
  saveVersion: (id: string, name: string) => call<{ id: number }>("POST", `/api/sheets/${id}/versions`, { name }),
  restore: (id: string, vid: number) => call<{ ok: true }>("POST", `/api/sheets/${id}/versions/${vid}/restore`, {}),
  exportUrl: (id: string, tab: string) => `/api/sheets/${id}/export.csv?tab=${encodeURIComponent(tab)}`,
};
