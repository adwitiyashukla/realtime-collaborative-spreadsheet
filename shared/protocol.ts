import { z } from "zod";
import { FORMAT_PATTERN } from "./calc/format.ts";
import { ID_PATTERN } from "./ids.ts";
import { type DocJSON, type Limits, MAX_SIZE, MIN_SIZE } from "./model.ts";
import type { Entry } from "./sync.ts";

const id = z.string().regex(ID_PATTERN);
const axis = z.enum(["row", "col"]);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const flag = z.boolean().nullable().optional();

const stylePatch = z.strictObject({
  b: flag,
  i: flag,
  u: flag,
  st: flag,
  fg: color.nullable().optional(),
  bg: color.nullable().optional(),
  al: z.enum(["left", "center", "right"]).nullable().optional(),
  nf: z.string().regex(FORMAT_PATTERN).nullable().optional(),
});

const tabName = z.string().min(1).max(100);

const selection = z.tuple([id, id, id, id]).nullable();

export function clientMessages(limits: Limits) {
  const text = z.string().max(limits.maxCellChars);
  const cells = limits.maxCellsPerOp;
  const lines = Math.max(limits.maxRows, limits.maxCols);
  const op = z.discriminatedUnion("t", [
    z.strictObject({ t: z.literal("set"), tab: id, cells: z.array(z.tuple([id, id, text.nullable()])).max(cells) }),
    z.strictObject({ t: z.literal("style"), tab: id, cells: z.array(z.tuple([id, id, stylePatch])).max(cells) }),
    z.strictObject({ t: z.literal("insert"), tab: id, axis, before: id.nullable(), ids: z.array(id).max(lines) }),
    z.strictObject({ t: z.literal("remove"), tab: id, axis, ids: z.array(id).max(lines) }),
    z.strictObject({ t: z.literal("restore"), tab: id, axis, ids: z.array(id).max(lines) }),
    z.strictObject({
      t: z.literal("resize"),
      tab: id,
      axis,
      sizes: z.array(z.tuple([id, z.number().int().min(MIN_SIZE).max(MAX_SIZE).nullable()])).max(lines),
    }),
    z.strictObject({
      t: z.literal("addTab"),
      id,
      name: tabName,
      before: id.nullable(),
      rows: z.array(id).max(limits.maxRows),
      cols: z.array(id).max(limits.maxCols),
      cells: z.array(z.tuple([id, id, text])).max(cells).optional(),
    }),
    z.strictObject({ t: z.literal("renameTab"), id, name: tabName }),
    z.strictObject({ t: z.literal("removeTab"), id, name: tabName.optional() }),
    z.strictObject({ t: z.literal("restoreTab"), id, name: tabName.optional() }),
    z.strictObject({ t: z.literal("moveTab"), id, before: id.nullable() }),
    z.strictObject({ t: z.literal("title"), title: z.string().min(1).max(200) }),
  ]);
  return z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("hello"), client: z.string().regex(/^[0-9A-Za-z]{6,32}$/), seq: z.number().int().min(-1) }),
    z.strictObject({ type: z.literal("op"), cseq: z.number().int().min(1), op }),
    z.strictObject({ type: z.literal("presence"), tab: id.nullable(), sel: selection, editing: z.boolean() }),
  ]);
}

export type ClientMessage = z.infer<ReturnType<typeof clientMessages>>;

export type SheetLimits = Limits & { defaultRows: number; defaultCols: number };

export type Role = "owner" | "editor" | "viewer";

export type Peer = {
  client: string;
  user: string;
  name: string;
  color: string;
  tab: string | null;
  sel: [string, string, string, string] | null;
  editing: boolean;
};

export type ServerMessage =
  | { type: "welcome"; seq: number; acked: number; role: Role; you: Peer; peers: Peer[]; limits: SheetLimits; state?: DocJSON; ops?: Entry[] }
  | { type: "ops"; ops: Entry[] }
  | { type: "reject"; cseq: number; reason: string }
  | { type: "presence"; peer: Peer }
  | { type: "leave"; client: string }
  | { type: "reset"; seq: number; state: DocJSON; by: string }
  | { type: "role"; role: Role }
  | { type: "closed"; reason: string };

export type User = { id: string; name: string; email: string | null; guest: boolean };

export type SheetSummary = {
  id: string;
  title: string;
  role: Role;
  owner: string;
  updatedAt: string;
  openedAt: string | null;
};

export type Member = { id: string; name: string; email: string | null; role: "editor" | "viewer" };

export type SheetMeta = {
  id: string;
  title: string;
  role: Role;
  owner: { id: string; name: string };
  linkAccess: "none" | "viewer" | "editor";
  members: Member[];
};

export type VersionInfo = {
  id: number;
  seq: number;
  kind: string;
  name: string | null;
  createdAt: string;
  editors: string[];
};

export const PEER_COLORS = ["#1a73e8", "#d93025", "#188038", "#e37400", "#9334e6", "#c5221f", "#007b83", "#b06000", "#5f6368", "#a142f4"];

export function colorFor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return PEER_COLORS[h % PEER_COLORS.length];
}
