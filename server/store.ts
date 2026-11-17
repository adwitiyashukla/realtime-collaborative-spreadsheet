import { and, asc, desc, eq, gt, inArray, lt, max, or, sql } from "drizzle-orm";
import type { DocJSON } from "../shared/model.ts";
import type { Member, Role, SheetSummary, User, VersionInfo } from "../shared/protocol.ts";
import type { Entry } from "../shared/sync.ts";
import type { Db } from "./db.ts";
import { members, opens, ops, sessions, sheets, users, versions } from "./schema.ts";

export type LinkAccess = "none" | "viewer" | "editor";

export type SheetRow = { id: string; ownerId: string; ownerName: string; title: string; linkAccess: LinkAccess };

type UserRow = typeof users.$inferSelect;

const toUser = (u: UserRow): User => ({ id: u.id, name: u.name, email: u.email, guest: u.guest });

export class Store {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async createUser(u: { id: string; email: string | null; name: string; passwordHash: string | null; guest: boolean }): Promise<User> {
    const [row] = await this.db.insert(users).values(u).returning();
    return toUser(row);
  }

  async userByEmail(email: string): Promise<(User & { passwordHash: string | null }) | null> {
    const [row] = await this.db.select().from(users).where(eq(users.email, email));
    return row ? { ...toUser(row), passwordHash: row.passwordHash } : null;
  }

  async upgradeGuest(id: string, email: string, name: string, passwordHash: string): Promise<User> {
    const [row] = await this.db.update(users).set({ email, name, passwordHash, guest: false }).where(eq(users.id, id)).returning();
    return toUser(row);
  }

  async createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void> {
    await this.db.insert(sessions).values({ tokenHash, userId, expiresAt });
  }

  async sessionUser(tokenHash: string): Promise<User | null> {
    const [row] = await this.db
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())));
    return row ? toUser(row.user) : null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  }

  async cleanup(guestDays: number): Promise<void> {
    await this.db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
    const cutoff = new Date(Date.now() - guestDays * 86400000);
    await this.db.delete(users).where(and(eq(users.guest, true), lt(users.createdAt, cutoff)));
  }

  async createSheet(id: string, ownerId: string, state: DocJSON, kind: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(sheets).values({ id, ownerId, title: state.title });
      await tx.insert(versions).values({ sheetId: id, seq: 0, kind, state, editors: [ownerId], createdBy: ownerId });
    });
  }

  async countSheets(ownerId: string): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(sheets).where(eq(sheets.ownerId, ownerId));
    return row.n;
  }

  async sheet(id: string): Promise<SheetRow | null> {
    const [row] = await this.db
      .select({ id: sheets.id, ownerId: sheets.ownerId, ownerName: users.name, title: sheets.title, linkAccess: sheets.linkAccess })
      .from(sheets)
      .innerJoin(users, eq(users.id, sheets.ownerId))
      .where(eq(sheets.id, id));
    return row ?? null;
  }

  async roleOf(sheetId: string, userId: string): Promise<Role | null> {
    const sheet = await this.sheet(sheetId);
    if (!sheet) return null;
    if (sheet.ownerId === userId) return "owner";
    const [m] = await this.db.select({ role: members.role }).from(members).where(and(eq(members.sheetId, sheetId), eq(members.userId, userId)));
    const order = { none: 0, viewer: 1, editor: 2 } as const;
    const best = Math.max(order[m?.role ?? "none"], order[sheet.linkAccess]);
    return best === 2 ? "editor" : best === 1 ? "viewer" : null;
  }

  async listSheets(userId: string): Promise<SheetSummary[]> {
    const rows = await this.db
      .select({
        id: sheets.id,
        title: sheets.title,
        ownerId: sheets.ownerId,
        ownerName: users.name,
        linkAccess: sheets.linkAccess,
        updatedAt: sheets.updatedAt,
        memberRole: members.role,
        openedAt: opens.openedAt,
      })
      .from(sheets)
      .innerJoin(users, eq(users.id, sheets.ownerId))
      .leftJoin(members, and(eq(members.sheetId, sheets.id), eq(members.userId, userId)))
      .leftJoin(opens, and(eq(opens.sheetId, sheets.id), eq(opens.userId, userId)))
      .where(
        or(
          eq(sheets.ownerId, userId),
          sql`${members.userId} is not null`,
          and(sql`${opens.userId} is not null`, sql`${sheets.linkAccess} <> 'none'`),
        ),
      )
      .orderBy(desc(sql`greatest(${sheets.updatedAt}, coalesce(${opens.openedAt}, ${sheets.updatedAt}))`))
      .limit(500);
    return rows.map((r) => {
      let role: Role = "viewer";
      if (r.ownerId === userId) role = "owner";
      else if (r.memberRole === "editor" || r.linkAccess === "editor") role = "editor";
      return {
        id: r.id,
        title: r.title,
        role,
        owner: r.ownerName,
        updatedAt: r.updatedAt.toISOString(),
        openedAt: r.openedAt ? r.openedAt.toISOString() : null,
      };
    });
  }

  async setLinkAccess(id: string, linkAccess: LinkAccess): Promise<void> {
    await this.db.update(sheets).set({ linkAccess }).where(eq(sheets.id, id));
  }

  async deleteSheet(id: string): Promise<void> {
    await this.db.delete(sheets).where(eq(sheets.id, id));
  }

  async members(sheetId: string): Promise<Member[]> {
    const rows = await this.db
      .select({ id: users.id, name: users.name, email: users.email, role: members.role })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.sheetId, sheetId))
      .orderBy(asc(users.name));
    return rows;
  }

  async addMember(sheetId: string, userId: string, role: "editor" | "viewer"): Promise<void> {
    await this.db
      .insert(members)
      .values({ sheetId, userId, role })
      .onConflictDoUpdate({ target: [members.sheetId, members.userId], set: { role } });
  }

  async removeMember(sheetId: string, userId: string): Promise<void> {
    await this.db.delete(members).where(and(eq(members.sheetId, sheetId), eq(members.userId, userId)));
  }

  async touchOpen(sheetId: string, userId: string): Promise<void> {
    await this.db
      .insert(opens)
      .values({ sheetId, userId })
      .onConflictDoUpdate({ target: [opens.sheetId, opens.userId], set: { openedAt: new Date() } });
  }

  async latestVersion(sheetId: string): Promise<{ seq: number; state: DocJSON } | null> {
    const [row] = await this.db
      .select({ seq: versions.seq, state: versions.state })
      .from(versions)
      .where(eq(versions.sheetId, sheetId))
      .orderBy(desc(versions.seq), desc(versions.id))
      .limit(1);
    return row ?? null;
  }

  async opsAfter(sheetId: string, seq: number): Promise<Entry[]> {
    const rows = await this.db
      .select()
      .from(ops)
      .where(and(eq(ops.sheetId, sheetId), gt(ops.seq, seq)))
      .orderBy(asc(ops.seq));
    return rows.map((r) => ({ seq: r.seq, client: r.clientId, cseq: r.cseq, user: r.userId, op: r.op }));
  }

  async appendOps(sheetId: string, batch: Entry[], title: string | null): Promise<void> {
    const last = batch[batch.length - 1].seq;
    await this.db.transaction(async (tx) => {
      await tx.insert(ops).values(batch.map((e) => ({ sheetId, seq: e.seq, clientId: e.client, cseq: e.cseq, userId: e.user, op: e.op })));
      await tx
        .update(sheets)
        .set(title === null ? { seq: last, updatedAt: new Date() } : { seq: last, updatedAt: new Date(), title })
        .where(eq(sheets.id, sheetId));
    });
  }

  async maxCseq(sheetId: string, clientId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: max(ops.cseq) })
      .from(ops)
      .where(and(eq(ops.sheetId, sheetId), eq(ops.clientId, clientId)));
    return row?.n ?? 0;
  }

  async insertVersion(
    v: { sheetId: string; seq: number; kind: string; name: string | null; state: DocJSON; editors: string[]; createdBy: string | null },
    moveSheet = false,
  ): Promise<number> {
    return await this.db.transaction(async (tx) => {
      const [row] = await tx.insert(versions).values(v).returning({ id: versions.id });
      if (moveSheet) await tx.update(sheets).set({ seq: v.seq, title: v.state.title, updatedAt: new Date() }).where(eq(sheets.id, v.sheetId));
      return row.id;
    });
  }

  async listVersions(sheetId: string, limit = 200): Promise<VersionInfo[]> {
    const rows = await this.db
      .select({ id: versions.id, seq: versions.seq, kind: versions.kind, name: versions.name, createdAt: versions.createdAt, editors: versions.editors })
      .from(versions)
      .where(eq(versions.sheetId, sheetId))
      .orderBy(desc(versions.seq), desc(versions.id))
      .limit(limit);
    const ids = [...new Set(rows.flatMap((r) => r.editors))];
    const names = new Map<string, string>();
    if (ids.length) {
      for (const u of await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))) names.set(u.id, u.name);
    }
    return rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      kind: r.kind,
      name: r.name,
      createdAt: r.createdAt.toISOString(),
      editors: r.editors.map((id) => names.get(id) ?? "Removed user"),
    }));
  }

  async versionState(sheetId: string, id: number): Promise<{ seq: number; state: DocJSON } | null> {
    const [row] = await this.db
      .select({ seq: versions.seq, state: versions.state })
      .from(versions)
      .where(and(eq(versions.sheetId, sheetId), eq(versions.id, id)));
    return row ?? null;
  }
}
