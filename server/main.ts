import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { migrate, openDatabase } from "./db.ts";

const config = loadConfig();
const database = await openDatabase(config.database.url, config.database.pglite_dir);
const applied = await migrate(database);
const { app, store } = await buildApp(config, database);
if (applied.length) app.log.info({ applied }, "migrations applied");
await store.cleanup(config.auth.guest_days);
const cleaner = setInterval(() => store.cleanup(config.auth.guest_days).catch((e) => app.log.error(e)), 6 * 3600 * 1000);
cleaner.unref();
await app.listen({ host: config.server.host, port: config.server.port });

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info("shutting down");
  await app.close();
  await database.close();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
