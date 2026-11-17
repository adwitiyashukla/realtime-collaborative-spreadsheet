import { type Change, Doc, type DocJSON, NO_LIMITS, type Op, checkOp } from "./model.ts";

export type Entry = { seq: number; client: string; cseq: number; user: string; op: Op };

type Pending = { cseq: number; op: Op; inverse: Op | null };

export class Replica {
  doc: Doc;
  seq: number;
  client: string;
  pending: Pending[] = [];
  private nextCseq = 1;

  constructor(state: DocJSON, seq: number, client: string) {
    this.doc = Doc.fromJSON(state);
    this.seq = seq;
    this.client = client;
  }

  local(op: Op): { cseq: number; changes: Change[] } | null {
    if (checkOp(this.doc, op, NO_LIMITS)) return null;
    const { inverse, changes } = this.doc.apply(op);
    const cseq = this.nextCseq++;
    this.pending.push({ cseq, op, inverse });
    return { cseq, changes };
  }

  receive(entries: Entry[]): Change[] {
    const changes: Change[] = [];
    let rolled = false;
    for (const e of entries) {
      if (e.seq <= this.seq) continue;
      if (e.seq !== this.seq + 1) throw new Error(`missing ops between ${this.seq} and ${e.seq}`);
      if (!rolled && e.client === this.client && this.pending[0]?.cseq === e.cseq) {
        this.pending.shift();
      } else {
        if (!rolled && this.pending.length) {
          this.rollback(changes);
          rolled = true;
        }
        if (e.client === this.client) {
          const i = this.pending.findIndex((p) => p.cseq === e.cseq);
          if (i >= 0) this.pending.splice(i, 1);
        }
        changes.push(...this.doc.apply(e.op).changes);
      }
      this.seq = e.seq;
    }
    if (rolled) this.replay(changes);
    return changes;
  }

  catchUp(entries: Entry[], acked: number): Change[] {
    const changes = this.receive(entries);
    for (const p of this.pending.filter((x) => x.cseq <= acked)) changes.push(...this.reject(p.cseq));
    return changes;
  }

  reject(cseq: number): Change[] {
    const i = this.pending.findIndex((p) => p.cseq === cseq);
    if (i < 0) return [];
    const changes: Change[] = [];
    this.rollback(changes);
    this.pending.splice(i, 1);
    this.replay(changes);
    return changes;
  }

  reset(state: DocJSON, seq: number, acked: number | null): void {
    this.doc = Doc.fromJSON(state);
    this.seq = seq;
    this.pending = acked === null ? [] : this.pending.filter((p) => p.cseq > acked);
    this.replay([]);
  }

  private rollback(changes: Change[]): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const inv = this.pending[i].inverse;
      if (inv) changes.push(...this.doc.apply(inv).changes);
    }
  }

  private replay(changes: Change[]): void {
    const kept: Pending[] = [];
    for (const p of this.pending) {
      if (checkOp(this.doc, p.op, NO_LIMITS)) continue;
      const { inverse, changes: ch } = this.doc.apply(p.op);
      p.inverse = inverse;
      changes.push(...ch);
      kept.push(p);
    }
    this.pending = kept;
  }
}
