import { bigint, bigserial, boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { DocJSON, Op } from "../shared/model.ts";

const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email"),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),
  guest: boolean("guest").notNull().default(false),
  createdAt: time("created_at").notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
  expiresAt: time("expires_at").notNull(),
});

export const sheets = pgTable("sheets", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  title: text("title").notNull(),
  linkAccess: text("link_access").$type<"none" | "viewer" | "editor">().notNull().default("none"),
  seq: bigint("seq", { mode: "number" }).notNull().default(0),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
});

export const members = pgTable("members", {
  sheetId: text("sheet_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").$type<"editor" | "viewer">().notNull(),
});

export const opens = pgTable("opens", {
  sheetId: text("sheet_id").notNull(),
  userId: text("user_id").notNull(),
  openedAt: time("opened_at").notNull().defaultNow(),
});

export const ops = pgTable("ops", {
  sheetId: text("sheet_id").notNull(),
  seq: bigint("seq", { mode: "number" }).notNull(),
  clientId: text("client_id").notNull(),
  cseq: integer("cseq").notNull(),
  userId: text("user_id").notNull(),
  op: jsonb("op").$type<Op>().notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
});

export const versions = pgTable("versions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sheetId: text("sheet_id").notNull(),
  seq: bigint("seq", { mode: "number" }).notNull(),
  kind: text("kind").notNull(),
  name: text("name"),
  state: jsonb("state").$type<DocJSON>().notNull(),
  editors: text("editors").array().notNull(),
  createdBy: text("created_by"),
  createdAt: time("created_at").notNull().defaultNow(),
});
