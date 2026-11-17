import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";

export type Stats = { p50: number; p95: number; p99: number; max: number; mean: number };

export function stats(samples: number[]): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length };
}

export function ms(v: number): string {
  return v >= 100 ? `${v.toFixed(0)} ms` : v >= 10 ? `${v.toFixed(1)} ms` : `${v.toFixed(2)} ms`;
}

export function table(rows: string[][]): void {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const [i, r] of rows.entries()) {
    console.log(r.map((v, j) => (j === 0 ? v.padEnd(widths[j]) : v.padStart(widths[j]))).join("   "));
    if (i === 0) console.log(widths.map((w) => "-".repeat(w)).join("   "));
  }
}

export function machine(): string {
  return `${os.cpus()[0]?.model.trim() ?? "unknown cpu"}, ${os.cpus().length} threads, Node ${process.version}`;
}

export function save(name: string, data: unknown): void {
  mkdirSync("bench/results", { recursive: true });
  writeFileSync(`bench/results/${name}.json`, JSON.stringify({ machine: machine(), at: new Date().toISOString(), ...(data as object) }, null, 2));
}
