import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { Calc } from "../shared/calc/engine.ts";
import { csvInput, parseCsv, toCsv } from "../shared/csv.ts";
import { idMaker, randomId } from "../shared/ids.ts";
import { Doc, newDoc, validTabName } from "../shared/model.ts";
import type { Role, SheetMeta, User } from "../shared/protocol.ts";
import { requireUser } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Rooms } from "./rooms.ts";
import type { Store } from "./store.ts";
import { demoDoc } from "./template.ts";

const idParam = z.object({ id: z.string().regex(/^[0-9A-Za-z]{6,24}$/) });
const createBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  template: z.enum(["blank", "demo"]).optional(),
});
const accessBody = z.object({ linkAccess: z.enum(["none", "viewer", "editor"]) });
const memberBody = z.object({ email: z.string().trim().max(200), role: z.enum(["editor", "viewer"]) });
const versionBody = z.object({ name: z.string().trim().min(1).max(100) });

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export function registerSheets(app: FastifyInstance, store: Store, rooms: Rooms, config: Config): void {
  const { limits } = config;

  async function access(req: FastifyRequest, reply: FastifyReply, need: Role): Promise<{ user: User; id: string; role: Role } | null> {
    const user = requireUser(req, reply);
    if (!user) return null;
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      void reply.code(404).send({ error: "Sheet not found" });
      return null;
    }
    const role = await store.roleOf(params.data.id, user.id);
    if (!role) {
      void reply.code(404).send({ error: "Sheet not found or you do not have access" });
      return null;
    }
    if (RANK[role] < RANK[need]) {
      void reply.code(403).send({ error: need === "owner" ? "Only the owner can do that" : "You can only view this sheet" });
      return null;
    }
    return { user, id: params.data.id, role };
  }

  async function underLimit(user: User, reply: FastifyReply): Promise<boolean> {
    if ((await store.countSheets(user.id)) < limits.max_sheets_per_user) return true;
    void reply.code(403).send({ error: `You can have up to ${limits.max_sheets_per_user} sheets. Delete one to make room.` });
    return false;
  }

  async function meta(id: string, role: Role): Promise<SheetMeta> {
    const sheet = (await store.sheet(id))!;
    return {
      id,
      title: sheet.title,
      role,
      owner: { id: sheet.ownerId, name: sheet.ownerName },
      linkAccess: sheet.linkAccess,
      members: role === "owner" ? await store.members(id) : [],
    };
  }

  app.addContentTypeParser("text/csv", { parseAs: "string", bodyLimit: limits.max_import_bytes }, (_req, body, done) => done(null, body));

  app.get("/api/sheets", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    return { sheets: await store.listSheets(user.id) };
  });

  app.post("/api/sheets", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = createBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "Bad request" });
    if (!(await underLimit(user, reply))) return;
    const next = idMaker();
    const demo = body.data.template === "demo";
    const doc = demo ? demoDoc(next, limits.default_rows, limits.default_cols) : newDoc(limits.default_rows, limits.default_cols, next, body.data.title);
    const id = randomId(12);
    await store.createSheet(id, user.id, doc.toJSON(), demo ? "template" : "create");
    return { id };
  });

  app.post("/api/sheets/import", { bodyLimit: limits.max_import_bytes }, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    if (typeof req.body !== "string") return reply.code(415).send({ error: "Send the file as text/csv" });
    if (!(await underLimit(user, reply))) return;
    const rows = parseCsv(req.body);
    while (rows.length && rows[rows.length - 1].every((v) => v === "")) rows.pop();
    if (!rows.length) return reply.code(400).send({ error: "The file is empty" });
    const width = Math.max(...rows.map((r) => r.length));
    if (rows.length > limits.max_rows || width > limits.max_cols) {
      return reply.code(413).send({ error: `Files can have up to ${limits.max_rows} rows and ${limits.max_cols} columns` });
    }
    const query = z.object({ name: z.string().max(200).optional() }).safeParse(req.query);
    const base = (query.success && query.data.name ? query.data.name : "Imported sheet").replace(/\.csv$/i, "").trim() || "Imported sheet";
    const next = idMaker();
    const doc = newDoc(
      Math.max(limits.default_rows, rows.length),
      Math.max(limits.default_cols, width),
      next,
      base.slice(0, 200),
    );
    const tab = doc.liveTabs()[0];
    const name = base.slice(0, 100);
    if (validTabName(name)) doc.apply({ t: "renameTab", id: tab.id, name });
    const cells: [string, string, string][] = [];
    rows.forEach((line, r) => {
      const row = tab.rows.idAt(r)!;
      line.forEach((v, c) => {
        if (v === "") return;
        cells.push([row, tab.cols.idAt(c)!, csvInput(v, limits.max_cell_chars)]);
      });
    });
    if (cells.length) doc.apply({ t: "set", tab: tab.id, cells });
    const id = randomId(12);
    await store.createSheet(id, user.id, doc.toJSON(), "import");
    return { id, rows: rows.length, cols: width };
  });

  app.get("/api/sheets/:id", async (req, reply) => {
    const a = await access(req, reply, "viewer");
    if (!a) return;
    return meta(a.id, a.role);
  });

  app.patch("/api/sheets/:id", async (req, reply) => {
    const a = await access(req, reply, "owner");
    if (!a) return;
    const body = accessBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Bad request" });
    await store.setLinkAccess(a.id, body.data.linkAccess);
    await rooms.refreshRoles(a.id);
    return meta(a.id, a.role);
  });

  app.delete("/api/sheets/:id", async (req, reply) => {
    const a = await access(req, reply, "owner");
    if (!a) return;
    rooms.close(a.id, "This sheet was deleted by its owner");
    await store.deleteSheet(a.id);
    return { ok: true };
  });

  app.post("/api/sheets/:id/members", async (req, reply) => {
    const a = await access(req, reply, "owner");
    if (!a) return;
    const body = memberBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Bad request" });
    const target = await store.userByEmail(body.data.email.toLowerCase());
    if (!target || target.guest) return reply.code(404).send({ error: "No account uses that email yet" });
    if (target.id === a.user.id) return reply.code(400).send({ error: "You already own this sheet" });
    await store.addMember(a.id, target.id, body.data.role);
    await rooms.refreshRoles(a.id, target.id);
    return meta(a.id, a.role);
  });

  app.delete("/api/sheets/:id/members/:userId", async (req, reply) => {
    const a = await access(req, reply, "owner");
    if (!a) return;
    const { userId } = req.params as { userId: string };
    await store.removeMember(a.id, String(userId));
    await rooms.refreshRoles(a.id, String(userId));
    return meta(a.id, a.role);
  });

  app.post("/api/sheets/:id/copy", async (req, reply) => {
    const a = await access(req, reply, "viewer");
    if (!a) return;
    if (!(await underLimit(a.user, reply))) return;
    const current = await rooms.state(a.id);
    if (!current) return reply.code(404).send({ error: "Sheet not found" });
    const state = { ...current.state, title: ("Copy of " + current.state.title).slice(0, 200) };
    const id = randomId(12);
    await store.createSheet(id, a.user.id, state, "copy");
    return { id };
  });

  app.get("/api/sheets/:id/versions", async (req, reply) => {
    const a = await access(req, reply, "viewer");
    if (!a) return;
    return { versions: await store.listVersions(a.id) };
  });

  app.post("/api/sheets/:id/versions", async (req, reply) => {
    const a = await access(req, reply, "editor");
    if (!a) return;
    const body = versionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Give the version a name" });
    const id = await rooms.snapshot(a.id, "named", body.data.name, a.user.id);
    return { id };
  });

  app.get("/api/sheets/:id/versions/:vid", async (req, reply) => {
    const a = await access(req, reply, "viewer");
    if (!a) return;
    const vid = Number((req.params as { vid: string }).vid);
    const version = Number.isSafeInteger(vid) ? await store.versionState(a.id, vid) : null;
    if (!version) return reply.code(404).send({ error: "Version not found" });
    return version;
  });

  app.post("/api/sheets/:id/versions/:vid/restore", async (req, reply) => {
    const a = await access(req, reply, "editor");
    if (!a) return;
    const vid = Number((req.params as { vid: string }).vid);
    const version = Number.isSafeInteger(vid) ? await store.versionState(a.id, vid) : null;
    if (!version) return reply.code(404).send({ error: "Version not found" });
    await rooms.restore(a.id, version.state, a.user);
    return { ok: true };
  });

  app.get("/api/sheets/:id/export.csv", async (req, reply) => {
    const a = await access(req, reply, "viewer");
    if (!a) return;
    const current = await rooms.state(a.id);
    if (!current) return reply.code(404).send({ error: "Sheet not found" });
    const doc = Doc.fromJSON(current.state);
    const wanted = (req.query as { tab?: string }).tab;
    const tab = (wanted && doc.tab(wanted) && !doc.tab(wanted)!.dead ? doc.tab(wanted) : doc.liveTabs()[0])!;
    const calc = new Calc(doc);
    calc.recalc();
    let lastRow = -1;
    let lastCol = -1;
    tab.forEach((row, col, cell) => {
      if (cell.v === undefined || !tab.rows.isLive(row) || !tab.cols.isLive(col)) return;
      lastRow = Math.max(lastRow, tab.rows.indexOf(row));
      lastCol = Math.max(lastCol, tab.cols.indexOf(col));
    });
    const lines: string[][] = [];
    for (let r = 0; r <= lastRow; r++) {
      const row = tab.rows.idAt(r)!;
      const fields: string[] = [];
      for (let c = 0; c <= lastCol; c++) {
        const col = tab.cols.idAt(c)!;
        const text = calc.display(tab.id, row, col);
        fields.push(typeof calc.value(tab.id, row, col) === "string" && /^[=+\-@\t\r]/.test(text) ? "'" + text : text);
      }
      lines.push(fields);
    }
    const file = `${doc.title} - ${tab.name}`.replace(/[^A-Za-z0-9 _.-]/g, "_").slice(0, 120);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${file}.csv"`)
      .send(toCsv(lines));
  });

  app.get("/api/live/:id", {
    websocket: true,
    preValidation: async (req, reply) => {
      const a = await access(req, reply, "viewer");
      if (a) (req as FastifyRequest & { role?: Role }).role = a.role;
    },
  }, (socket, req) => {
    const r = req as FastifyRequest & { role?: Role };
    const { id } = idParam.parse(req.params);
    rooms.connect(id, socket, req.user!, r.role!);
  });
}
