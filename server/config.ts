import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { z } from "zod";

const int = (min: number, max: number) => z.number().int().min(min).max(max);

const schema = z.strictObject({
  server: z.strictObject({
    host: z.string().min(1),
    port: int(0, 65535),
    log_level: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]),
    trust_proxy: z.boolean(),
    public_dir: z.string(),
    allowed_origins: z.array(z.url()),
    frame_ancestors: z.array(z.url()),
  }),
  database: z.strictObject({
    url: z.string(),
    pglite_dir: z.string().min(1),
  }),
  auth: z.strictObject({
    session_days: int(1, 365),
    secure_cookies: z.boolean(),
    same_site: z.enum(["lax", "strict", "none"]),
    login_per_minute: int(1, 10000),
    signup_per_hour: int(1, 10000),
    guest_per_hour: int(1, 10000),
    guest_days: int(1, 365),
  }),
  rooms: z.strictObject({
    idle_unload_seconds: int(1, 86400),
    snapshot_every_ops: int(1, 1000000),
    snapshot_every_seconds: int(1, 86400),
    max_batch: int(1, 100000),
    catchup_ops: int(0, 1000000),
    max_message_bytes: int(1024, 100000000),
    messages_per_second: int(1, 100000),
    message_burst: int(1, 1000000),
    heartbeat_seconds: int(1, 3600),
  }),
  limits: z.strictObject({
    max_rows: int(10, 1000000),
    max_cols: int(5, 1000),
    max_tabs: int(1, 500),
    max_cell_chars: int(100, 1000000),
    max_cells_per_op: int(100, 2000000),
    max_import_bytes: int(1024, 500000000),
    max_sheets_per_user: int(1, 100000),
    default_rows: int(10, 100000),
    default_cols: int(5, 1000),
  }),
  e2e: z.strictObject({
    port: int(1, 65535),
  }),
  bench: z.strictObject({
    recalc_rows: int(100, 1000000),
    sync_clients: int(1, 1000),
    sync_ops_per_client: int(1, 100000),
    sync_rate_per_client: int(1, 1000),
    scroll_rows: int(100, 1000000),
    scroll_seconds: int(1, 600),
  }),
});

export type Config = z.infer<typeof schema>;

const ENV: Record<string, [keyof Config, string]> = {
  PORT: ["server", "port"],
  HOST: ["server", "host"],
  DATABASE_URL: ["database", "url"],
};

function coerce(raw: string, current: unknown): unknown {
  if (typeof current === "number") return Number(raw);
  if (typeof current === "boolean") return raw === "1" || raw.toLowerCase() === "true";
  if (Array.isArray(current)) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return raw;
}

export function loadConfig(path = process.env.SPREADSHEET_CONFIG ?? "config.toml", env: NodeJS.ProcessEnv = process.env): Config {
  const data = parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown>>;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    let target = ENV[name];
    if (!target && name.startsWith("SPREADSHEET_") && name !== "SPREADSHEET_CONFIG") {
      const rest = name.slice("SPREADSHEET_".length).toLowerCase();
      const section = Object.keys(data).find((s) => rest.startsWith(s + "_"));
      if (section) target = [section as keyof Config, rest.slice(section.length + 1)];
    }
    if (!target) continue;
    const [section, key] = target;
    if (!data[section] || !(key in data[section])) throw new Error(`Unknown config override ${name}`);
    data[section][key] = coerce(value, data[section][key]);
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid config: ${issues}`);
  }
  const config = result.data;
  if (config.auth.same_site === "none" && !config.auth.secure_cookies) {
    throw new Error("Invalid config: auth.same_site = none needs auth.secure_cookies = true");
  }
  if (config.limits.default_rows > config.limits.max_rows || config.limits.default_cols > config.limits.max_cols) {
    throw new Error("Invalid config: default sheet size is larger than the limits");
  }
  return config;
}
