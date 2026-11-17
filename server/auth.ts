import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { randomId } from "../shared/ids.ts";
import type { User } from "../shared/protocol.ts";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
    sessionHash: string | null;
  }
}

export const COOKIE = "spreadsheet_session";

const COST = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function derive(password: string, salt: Buffer, length: number, cost: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, length, { ...cost, maxmem: COST.maxmem }, (e, key) => (e ? reject(e) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, 64, COST);
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, key] = stored.split("$");
  if (algo !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = await derive(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(actual, expected);
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const ANIMALS = ["Otter", "Heron", "Lynx", "Falcon", "Badger", "Koala", "Panda", "Gecko", "Bison", "Orca", "Raven", "Moose", "Tiger", "Llama", "Puffin", "Walrus", "Ibex", "Marten", "Quokka", "Narwhal"];

const signupBody = z.object({
  email: z.email().max(200),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(60),
});

const loginBody = z.object({ email: z.string().max(200), password: z.string().max(200) });

export function requireUser(req: FastifyRequest, reply: FastifyReply): User | null {
  if (req.user) return req.user;
  void reply.code(401).send({ error: "Please sign in first" });
  return null;
}

export function registerAuth(app: FastifyInstance, store: Store, config: Config): void {
  app.decorateRequest("user", null);
  app.decorateRequest("sessionHash", null);

  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/api/")) return;
    const token = req.cookies[COOKIE];
    if (!token) return;
    const hash = hashToken(token);
    const user = await store.sessionUser(hash);
    if (user) {
      req.user = user;
      req.sessionHash = hash;
    }
  });

  const startSession = async (reply: FastifyReply, userId: string) => {
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + config.auth.session_days * 86400000);
    await store.createSession(hashToken(token), userId, expires);
    reply.setCookie(COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: config.auth.same_site,
      secure: config.auth.secure_cookies,
      partitioned: config.auth.same_site === "none",
      expires,
    });
  };

  app.post("/api/auth/signup", { config: { rateLimit: { max: config.auth.signup_per_hour, timeWindow: "1 hour" } } }, async (req, reply) => {
    const body = signupBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Enter a name, a valid email and a password with at least 8 characters" });
    const email = body.data.email.trim().toLowerCase();
    if (await store.userByEmail(email)) return reply.code(409).send({ error: "That email already has an account" });
    const hash = await hashPassword(body.data.password);
    let user: User;
    if (req.user?.guest) {
      user = await store.upgradeGuest(req.user.id, email, body.data.name, hash);
      if (req.sessionHash) await store.deleteSession(req.sessionHash);
    } else {
      user = await store.createUser({ id: randomId(), email, name: body.data.name, passwordHash: hash, guest: false });
    }
    await startSession(reply, user.id);
    return { user };
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: config.auth.login_per_minute, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Enter your email and password" });
    const found = await store.userByEmail(body.data.email.trim().toLowerCase());
    let ok = false;
    if (found?.passwordHash) ok = await verifyPassword(body.data.password, found.passwordHash);
    else await hashPassword(body.data.password);
    if (!found || !ok) return reply.code(401).send({ error: "Wrong email or password" });
    if (req.sessionHash) await store.deleteSession(req.sessionHash);
    await startSession(reply, found.id);
    return { user: { id: found.id, name: found.name, email: found.email, guest: found.guest } };
  });

  app.post("/api/auth/guest", { config: { rateLimit: { max: config.auth.guest_per_hour, timeWindow: "1 hour" } } }, async (req, reply) => {
    if (req.user) return { user: req.user };
    const name = "Guest " + ANIMALS[randomInt(ANIMALS.length)];
    const user = await store.createUser({ id: randomId(), email: null, name, passwordHash: null, guest: true });
    await startSession(reply, user.id);
    return { user };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.sessionHash) await store.deleteSession(req.sessionHash);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => ({ user: req.user }));
}
