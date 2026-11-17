import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Database } from "./db.ts";
import { Rooms } from "./rooms.ts";
import { registerSheets } from "./sheets.ts";
import { Store } from "./store.ts";

export type App = { app: FastifyInstance; rooms: Rooms; store: Store };

function originOk(origin: string, host: string | undefined, allowed: string[]): boolean {
  try {
    const url = new URL(origin);
    return url.host === host || allowed.some((a) => new URL(a).origin === url.origin);
  } catch {
    return false;
  }
}

export async function buildApp(config: Config, database: Database, logger = true): Promise<App> {
  const app = Fastify({
    logger: logger ? { level: config.server.log_level } : false,
    trustProxy: config.server.trust_proxy,
    bodyLimit: 2 * 1024 * 1024,
  });
  const store = new Store(database.db);
  const rooms = new Rooms(store, config, (e) => app.log.error(e));

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: config.rooms.max_message_bytes } });

  app.addHook("onRequest", async (req, reply) => {
    const upgrade = req.headers.upgrade?.toLowerCase() === "websocket";
    if (!upgrade && ["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const origin = req.headers.origin;
    if (origin && !originOk(origin, req.headers.host, config.server.allowed_origins)) {
      return reply.code(403).send({ error: "Requests from other sites are not allowed" });
    }
  });

  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    `frame-ancestors 'self' ${config.server.frame_ancestors.join(" ")}`.trim(),
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "same-origin");
    reply.header("content-security-policy", csp);
    return payload;
  });

  app.setErrorHandler((error: { statusCode?: number; message?: string }, req, reply) => {
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) req.log.error(error);
    void reply.code(status).send({ error: status === 500 ? "Something went wrong on the server" : (error.message ?? "Bad request") });
  });

  registerAuth(app, store, config);
  registerSheets(app, store, rooms, config);
  app.get("/api/health", async () => ({ ok: true, database: database.kind }));

  const publicDir = resolve(config.server.public_dir);
  if (existsSync(join(publicDir, "index.html"))) {
    await app.register(fastifyStatic, {
      root: publicDir,
      setHeaders: (res, path) => {
        res.header("cache-control", path.includes(`${join(publicDir, "assets")}`) ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.header("cache-control", "no-cache").sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }));
  }

  app.addHook("onClose", async () => {
    await rooms.closeAll();
  });
  return { app, rooms, store };
}
