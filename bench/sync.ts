import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { buildApp } from "../server/app.ts";
import { loadConfig } from "../server/config.ts";
import { migrate, openDatabase } from "../server/db.ts";
import type { Op } from "../shared/model.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import { type Stats, machine, ms, save, stats, table } from "./util.ts";

type Result = { maxBatch: number; latency: Stats; seconds: number; ops: number; commits: number };

const json = (base: string, cookie = "") => ({ "content-type": "application/json", origin: base, cookie });

async function guest(base: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/guest`, { method: "POST", headers: json(base), body: "{}" });
  if (!res.ok) throw new Error(`guest login failed with ${res.status}`);
  return res.headers.getSetCookie()[0].split(";")[0];
}

async function run(maxBatch: number): Promise<Result> {
  const config = loadConfig();
  config.rooms.max_batch = maxBatch;
  config.auth.guest_per_hour = 1000000;
  const { sync_clients: count, sync_ops_per_client: perClient, sync_rate_per_client: rate } = config.bench;
  const database = await openDatabase(config.database.url, "memory://");
  await migrate(database);
  const { app, rooms } = await buildApp(config, database, false);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const owner = await guest(base);
  const { id } = (await (await fetch(`${base}/api/sheets`, { method: "POST", headers: json(base, owner), body: JSON.stringify({ template: "blank" }) })).json()) as { id: string };
  await fetch(`${base}/api/sheets/${id}`, { method: "PATCH", headers: json(base, owner), body: JSON.stringify({ linkAccess: "editor" }) });

  const total = count * perClient;
  const latencies: number[] = [];
  let finished = 0;
  let done!: () => void;
  const allDone = new Promise<void>((resolve) => (done = resolve));

  const clients = await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const cookie = await guest(base);
      const client = `bench${i}x${Date.now().toString(36)}`;
      const ws = new WebSocket(`${base.replace("http", "ws")}/api/live/${id}`, { headers: { cookie, origin: base } });
      const sent = new Map<number, number>();
      let seen = 0;
      const welcome = await new Promise<Extract<ServerMessage, { type: "welcome" }>>((resolve, reject) => {
        ws.on("open", () => ws.send(JSON.stringify({ type: "hello", client, seq: -1 })));
        ws.on("error", reject);
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString()) as ServerMessage;
          if (msg.type === "welcome") resolve(msg);
          if (msg.type !== "ops") return;
          const now = performance.now();
          for (const e of msg.ops) {
            if (e.client === client) latencies.push(now - sent.get(e.cseq)!);
          }
          seen += msg.ops.length;
          if (seen === total && ++finished === count) done();
        });
      });
      return { ws, sent, tab: welcome.state!.tabs[0] };
    }),
  );

  const started = performance.now();
  await Promise.all(
    clients.map(async ({ ws, sent, tab }, i) => {
      const offset = Math.random() * (1000 / rate);
      for (let k = 1; k <= perClient; k++) {
        const wait = started + offset + ((k - 1) * 1000) / rate - performance.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const op: Op = { t: "set", tab: tab.id, cells: [[tab.rows[(i * perClient + k) % tab.rows.length], tab.cols[i % tab.cols.length], String(k)]] };
        sent.set(k, performance.now());
        ws.send(JSON.stringify({ type: "op", cseq: k, op }));
      }
    }),
  );
  const timeout = setTimeout(() => {
    console.error("Timed out waiting for every client to see every edit");
    process.exit(1);
  }, 120000);
  await allDone;
  clearTimeout(timeout);
  const seconds = (performance.now() - started) / 1000;
  const commits = rooms.loaded(id)!.stats.batches;
  for (const c of clients) c.ws.close();
  await app.close();
  await database.close();
  return { maxBatch, latency: stats(latencies), seconds, ops: total, commits };
}

const config = loadConfig();
const { sync_clients: count, sync_ops_per_client: perClient, sync_rate_per_client: rate } = config.bench;
const grouped = await run(config.rooms.max_batch);
const single = await run(1);
console.log(`Sync benchmark on ${machine()}, database ${config.database.url ? "Postgres" : "PGlite"}`);
console.log(`${count} clients, each sending ${perClient} edits at ${rate} per second, every client sees every edit\n`);
const row = (label: string, f: (r: Result) => string) => [label, f(grouped), f(single)];
table([
  ["", "group commit", "one commit per edit"],
  row("edits per second", (r) => (r.ops / r.seconds).toFixed(0)),
  row("latency median", (r) => ms(r.latency.p50)),
  row("latency p95", (r) => ms(r.latency.p95)),
  row("latency p99", (r) => ms(r.latency.p99)),
  row("database commits", (r) => String(r.commits)),
  row("edits per commit", (r) => (r.ops / r.commits).toFixed(1)),
]);
save("sync", { clients: count, perClient, rate, grouped, single });
