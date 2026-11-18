// Git object model + packfile codec (no git binary, stdlib only).
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: GitObjectType; data: Buffer; }
export interface TreeEntry { mode: string; name: string; oid: string; }
const HEX40 = /^[0-9a-f]{40}$/;
export function isOid(v: string): boolean { return HEX40.test(v); }
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const out: TreeEntry[] = []; let off = 0;
  while (off < buf.length) {
    const sp = buf.indexOf(0x20, off); const nul = buf.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > buf.length) throw new Error('bad tree');
    out.push({ mode: buf.subarray(off, sp).toString('ascii'), name: buf.subarray(sp + 1, nul).toString('utf8'), oid: buf.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return out;
}
export interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string; }
export function parseCommit(data: Uint8Array): CommitView {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const head = blank < 0 ? buf.toString('utf8') : buf.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8');
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of head.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp); const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v; else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v; else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}
export interface TagView { object: string; type: string; tag: string; tagger: string; message: string; }
export function parseTag(data: Uint8Array): TagView {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const head = blank < 0 ? buf.toString('utf8') : buf.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8');
  const m = new Map<string, string>();
  for (const line of head.split('\n')) { const sp = line.indexOf(' '); if (sp > 0) m.set(line.slice(0, sp), line.slice(sp + 1)); }
  return { object: m.get('object') ?? '', type: m.get('type') ?? '', tag: m.get('tag') ?? '', tagger: m.get('tagger') ?? '', message };
}

// ---- pkt-line ----
export function pktLine(s: string | Buffer): Buffer {
  const data = typeof s === 'string' ? Buffer.from(s, 'utf8') : s;
  const h = Buffer.alloc(4); h.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([h, data]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
/** Decode pkt-lines from a buffer; returns packets and byte offset where raw data starts. */
export interface PktPacket { kind: 'data' | 'flush' | 'delim' | 'response-end'; payload: Buffer; }
export function decodePktLines(buf: Buffer): { packets: PktPacket[]; rawOffset: number } {
  const packets: PktPacket[] = []; let off = 0;
  while (off + 4 <= buf.length) {
    const h = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(h)) break;
    const len = parseInt(h, 16);
    if (len === 0) { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { packets.push({ kind: 'response-end', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rawOffset: off };
}

// ---- packfile write (plain objects, no deltas) ----
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
function packObjHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let s = size;
  bytes.push(((code << 4) | (s & 0x0f)) | (s > 0x0f ? 0x80 : 0));
  s >>= 4;
  while (s > 0) { bytes.push((s & 0x7f) | (s > 0x7f ? 0x80 : 0)); s >>= 7; }
  return Buffer.from(bytes);
}
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii'); header.writeUInt32BE(2, 4); header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) {
    parts.push(packObjHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---- packfile read (with OFS/REF delta support) ----
function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = buf[off] & 0x7f; let shift = 7; let i = off + 1;
  while (buf[i - 1] & 0x80) { value |= (buf[i] & 0x7f) << shift; shift += 7; i += 1; }
  return { value, next: i };
}
/** Adler-32 (RFC 1950): the checksum that terminates every zlib stream. */
function adler32(data: Buffer): number {
  let a = 1; let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + (data[i] as number)) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}
/** Inflate the zlib stream starting at `off` (bounded by `end`); find its true end. */
function inflateAt(buf: Buffer, off: number, end: number, expectedSize: number): { data: Buffer; next: number } {
  // Fast path: inflate the whole remainder once (trailing bytes are ignored by inflateSync).
  let data: Buffer | undefined;
  try {
    const d = inflateSync(buf.subarray(off, end));
    if (d.length === expectedSize) data = d;
  } catch { /* fall through to search */ }
  if (data !== undefined) {
    // The stream ends with the Adler-32 of the data. Scan for those 4 bytes
    // (a deflate stream never expands by more than a few dozen bytes over its
    // uncompressed size, so the bound is tight) and verify the candidate with
    // one inflate: ~2 inflateSync calls instead of a ~12-step binary search.
    const want = adler32(data);
    const maxEnd = Math.min(end, off + expectedSize + 64);
    for (let e = off + 7; e <= maxEnd; e++) {
      if (buf.readUInt32BE(e - 4) === want) {
        try {
          const d = inflateSync(buf.subarray(off, e));
          if (d.length === expectedSize) return { data, next: e };
        } catch { /* not a real stream end: keep scanning */ }
      }
    }
    // Fall back to binary search for the minimal end that inflates correctly.
    let lo = off; let hi = end;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      try { const d = inflateSync(buf.subarray(off, mid)); if (d.length === expectedSize) hi = mid; else lo = mid; } catch { lo = mid; }
    }
    return { data, next: hi };
  }
  let lo = off; let hi = end; let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try { const d = inflateSync(buf.subarray(off, mid)); if (d.length === expectedSize) { found = mid; hi = mid - 1; } else lo = mid + 1; } catch { lo = mid + 1; }
  }
  if (found < 0) throw new Error('pack entry inflate failed');
  return { data: inflateSync(buf.subarray(off, found)), next: found };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readV = (): number => { let v = 0; let s = 0; for (;;) { const b = delta[off]; off += 1; v |= (b & 0x7f) << s; s += 7; if (!(b & 0x80)) break; } return v; };
  const srcSize = readV(); const tgtSize = readV();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  while (off < delta.length) {
    const op = delta[off]; off += 1;
    if (op & 0x80) {
      let cpOff = 0; let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { cpOff |= delta[off] << (8 * i); off += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { cpSize |= delta[off] << (8 * i); off += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
    } else if (op > 0) {
      out.push(delta.subarray(off, off + op)); off += op;
    } else throw new Error('delta op 0');
  }
  const res = Buffer.concat(out);
  if (res.length !== tgtSize) throw new Error('delta target size mismatch');
  return res;
}
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
export function readPack(pack: Uint8Array, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  const buf = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  interface Raw { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string; resolved?: { type: GitObjectType; data: Buffer; oid: string }; }
  const raw: Raw[] = []; const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    const first = buf[off]; const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f; let shift = 4; let j = off + 1;
    while (buf[j - 1] & 0x80) { size |= (buf[j] & 0x7f) << shift; shift += 7; j += 1; }
    off = j;
    const e: Raw = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = buf[off]; off += 1; let baseOff = b & 0x7f;
      while (b & 0x80) { b = buf[off]; off += 1; baseOff = ((baseOff + 1) << 7) | (b & 0x7f); }
      e.baseOffset = entryOffset - baseOff;
    } else if (typeCode === 7) {
      e.baseOid = buf.subarray(off, off + 20).toString('hex'); off += 20;
    } else if (!CODE_TYPE[typeCode]) throw new Error(`unknown pack type ${typeCode}`);
    const inf = inflateAt(buf, off, trailerStart, size);
    e.data = inf.data; off = inf.next;
    raw.push(e); byOffset.set(entryOffset, e);
  }
  const objects = new Map<string, GitObject>(); const byOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (e: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    if (e.resolved) return e.resolved;
    if (resolving.has(e.offset)) throw new Error('delta cycle');
    resolving.add(e.offset);
    let type: GitObjectType; let data: Buffer;
    if (e.typeCode === 6) {
      const base = byOffset.get(e.baseOffset as number);
      if (!base) throw new Error('ofs-delta base missing');
      const b = resolve(base); type = b.type; data = applyDelta(b.data, e.data);
    } else if (e.typeCode === 7) {
      const base = byOid.get(e.baseOid as string);
      if (base) { const b = resolve(base); type = b.type; data = applyDelta(b.data, e.data); }
      else {
        const ext = resolveBase?.(e.baseOid as string);
        if (!ext) throw new Error(`ref-delta base ${e.baseOid} missing`);
        type = ext.type; data = applyDelta(ext.data, e.data);
      }
    } else { type = CODE_TYPE[e.typeCode] as GitObjectType; data = e.data; }
    const oid = hashObject(type, data);
    e.resolved = { type, data, oid }; byOid.set(oid, e); resolving.delete(e.offset);
    return e.resolved;
  };
  for (const e of raw) { const r = resolve(e); if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data }); }
  return objects;
}
export function packChecksumOk(pack: Uint8Array): boolean {
  const buf = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buf.length < 20) return false;
  const actual = buf.subarray(buf.length - 20).toString('hex');
  const expected = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest('hex');
  return actual === expected;
}
