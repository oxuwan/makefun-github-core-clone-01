// Git smart HTTP: info/refs (v0/v2), ls-refs, upload-pack (v2/v0 fetch), receive-pack.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { decodePktLines, hashObject, isOid, parseCommit, parseTag, parseTree, pktLine, readPack, writePack, ZERO_OID, PKT_DELIM, PKT_FLUSH, type GitObject, type PktPacket } from './gitobj.ts';
import { getRepo, isAncestor, noteCommitOrder, peelToCommit, reachable, type Repo } from './store.ts';
import { authOk, errJson, readBody, sendRaw } from './common.ts';

const AGENT = 'github-forge/1.0';
const UPLOAD_V0_CAPS = `agent=${AGENT} multi_ack multi_ack_detailed side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/main object-format=sha1`;
const RECEIVE_CAPS = `agent=${AGENT} report-status side-band-64k delete-refs ofs-delta object-format=sha1`;

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}
function peelOf(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (!obj) return undefined;
  if (obj.type === 'tag') return peelToCommit(repo, oid);
  return undefined;
}
function sidebandWrap(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  let off = 0;
  while (off < data.length) {
    const chunk = data.subarray(off, off + 65515);
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
    off += chunk.length;
  }
  if (data.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}
function pktLines(items: (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(PKT_FLUSH);
    else if (it === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(it));
  }
  return Buffer.concat(parts);
}

function v0Advertisement(repo: Repo, service: string): Buffer {
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS : UPLOAD_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const mainTip = repo.refs.get('refs/heads/main');
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = mainTip ?? refs[0]?.oid ?? ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const r of refs) {
      parts.push(pktLine(`${r.oid} ${r.name}\n`));
      const peeled = peelOf(repo, r.oid);
      if (peeled) parts.push(pktLine(`${peeled} ${r.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
function v2Advertisement(service: string): Buffer {
  return pktLines([
    `# service=${service}\n`, 'flush',
    'version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow filter\n', 'server-option\n', 'object-format=sha1\n', 'flush',
  ]);
}

interface FetchParams { wants: string[]; haves: string[]; shallow: string[]; depth?: number; done: boolean; }
interface SendSet { objects: Map<string, GitObject>; shallowOut: string[]; unshallow: string[]; }
function computeSend(repo: Repo, p: FetchParams): SendSet {
  // Objects the client already holds. A shallow boundary commit is held
  // WITH its tree, but its parents are NOT held: do not descend below a
  // commit named in p.shallow (deepen relies on this).
  const haveReachable = new Set<string>();
  if (p.haves.length) {
    const shallowSet = new Set(p.shallow);
    const hq = [...p.haves];
    const hseen = new Set<string>();
    while (hq.length) {
      const oid = hq.shift() as string;
      if (hseen.has(oid)) continue;
      hseen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      if (obj.type === 'tag') {
        haveReachable.add(oid);
        const target = parseTag(obj.data).target;
        if (target) hq.push(target);
        continue;
      }
      if (obj.type !== 'commit') { haveReachable.add(oid); continue; }
      haveReachable.add(oid);
      const c = parseCommit(obj.data);
      const walk = (treeOid: string): void => {
        haveReachable.add(treeOid);
        const t = repo.objects.get(treeOid);
        if (!t) return;
        for (const e of parseTree(t.data)) {
          if (e.mode === '40000') walk(e.oid); else haveReachable.add(e.oid);
        }
      };
      walk(c.tree);
      if (!shallowSet.has(oid)) for (const par of c.parents) hq.push(par);
    }
  }
  // BFS commit generations from wants.
  const level = new Map<string, number>();
  const queue: string[] = [];
  for (const w of p.wants) { if (isOid(w) && !level.has(w)) { level.set(w, 0); queue.push(w); } }
  const commits = new Set<string>();
  const tagRoots = new Set<string>();
  const boundary = new Set<string>();
  while (queue.length) {
    const oid = queue.shift() as string;
    const lv = level.get(oid) as number;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      tagRoots.add(oid);
      const target = parseTag(obj.data).target;
      if (target && !level.has(target)) { level.set(target, lv); queue.push(target); }
      continue;
    }
    if (obj.type !== 'commit') continue;
    commits.add(oid);
    if (p.depth !== undefined && lv >= p.depth - 1) {
      // At the depth boundary when lv == depth-1 (or beyond): do not descend.
      if (lv === p.depth - 1) boundary.add(oid);
      continue;
    }
    if (p.depth !== undefined && lv >= p.depth) continue;
    const c = parseCommit(obj.data);
    for (const par of c.parents) {
      if (!level.has(par)) { level.set(par, lv + 1); queue.push(par); }
    }
  }
  // Objects: commits + their trees/blobs.
  const send = new Set<string>([...tagRoots]);
  if (p.depth === undefined) {
    for (const coid of commits) {
      try { for (const o of reachable(repo, [coid], true)) send.add(o); } catch { /* ignore */ }
    }
  } else {
    // Depth-limited: only the commits in `commits` and their trees/blobs
    // (no parent commits). Do NOT compute the full reachable closure first
    // and throw it away: on a 200-commit history that dominates clone time.
    for (const coid of commits) {
      send.add(coid);
      const obj = repo.objects.get(coid);
      if (!obj) continue;
      const tree = parseCommit(obj.data).tree;
      const walk = (treeOid: string): void => {
        send.add(treeOid);
        const t = repo.objects.get(treeOid);
        if (!t) return;
        for (const e of parseTree(t.data)) {
          if (e.mode === '40000') walk(e.oid); else send.add(e.oid);
        }
      };
      walk(tree);
    }
  }
  for (const o of haveReachable) send.delete(o);
  const objects = new Map<string, GitObject>();
  for (const oid of [...send].sort()) {
    const o = repo.objects.get(oid);
    if (o) objects.set(oid, o);
  }
  const shallowOut = p.depth !== undefined ? [...boundary].filter((o) => objects.has(o) || commits.has(o)).sort() : [];
  const unshallow: string[] = [];
  if (p.shallow.length) {
    for (const b of p.shallow) {
      const lv = level.get(b);
      // No longer shallow when its parents were traversed (level < depth-1) or depth is unlimited.
      if (lv !== undefined && (p.depth === undefined || lv < p.depth - 1)) unshallow.push(b);
    }
  }
  return { objects, shallowOut, unshallow };
}

function fetchResponseV2(repo: Repo, p: FetchParams): Buffer {
  const send = computeSend(repo, p);
  const pack = writePack([...send.objects.values()]);
  const parts: Buffer[] = [];
  // Real git framing (verified against git 2.43 upload-pack):
  // - acknowledgments section ONLY when the client sent haves and did NOT
  //   send `done` (multi-round negotiation): header, ACK lines, `ready`,
  //   then delim (no flush). When `done` was sent, no ack section at all.
  // - shallow-info section: header, `shallow <oid>` / `unshallow <oid>`
  //   lines WITHOUT trailing newline, then delim (no flush).
  // - packfile section: header, sideband packets, flush (no delim).
  if (p.haves.length && !p.done) {
    parts.push(pktLine('acknowledgments\n'));
    for (const h of p.haves) if (repo.objects.has(h)) parts.push(pktLine(`ACK ${h}\n`));
    parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }
  if (send.shallowOut.length || send.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of send.shallowOut) parts.push(pktLine(`shallow ${s}`));
    for (const s of send.unshallow) parts.push(pktLine(`unshallow ${s}`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandWrap(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
function fetchResponseV0(repo: Repo, p: FetchParams): Buffer {
  const send = computeSend(repo, p);
  const pack = writePack([...send.objects.values()]);
  const parts: Buffer[] = [];
  for (const s of send.shallowOut) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of send.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  let acked = false;
  for (const h of p.haves) { if (repo.objects.has(h)) { parts.push(pktLine(`ACK ${h}\n`)); acked = true; break; } }
  if (!acked) parts.push(pktLine('NAK\n'));
  parts.push(sidebandWrap(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function parseFetchLines(packets: PktPacket[]): FetchParams {
  const p: FetchParams = { wants: [], haves: [], shallow: [], done: false };
  for (const pkt of packets) {
    if (pkt.kind !== 'data') continue;
    const line = pkt.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) { const oid = line.slice(5).split(' ')[0] as string; if (isOid(oid)) p.wants.push(oid); }
    else if (line.startsWith('have ')) { const oid = line.slice(5).trim(); if (isOid(oid)) p.haves.push(oid); }
    else if (line.startsWith('shallow ')) { const oid = line.slice(8).trim(); if (isOid(oid)) p.shallow.push(oid); }
    else if (line.startsWith('deepen ')) { const n = parseInt(line.slice(7), 10); if (Number.isFinite(n) && n > 0) p.depth = n; }
    else if (line === 'done') p.done = true;
  }
  return p;
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, v2: boolean): Promise<void> {
  const body = await readBody(req);
  const { packets } = decodePktLines(body);
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
  const command = lines[0] ?? '';
  if (command === 'command=ls-refs') {
    // ---- ls-refs (v2) ----
    let peel = false; let symrefs = false; let unborn = false; const prefixes: string[] = [];
    for (const line of lines.slice(1)) {
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    }
    const out: Buffer[] = [];
    const refs = sortedRefs(repo);
    const mainTip = repo.refs.get('refs/heads/main');
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((pre) => name.startsWith(pre));
    if (prefixes.length === 0 || prefixes.some((pre) => 'HEAD'.startsWith(pre) || pre === 'HEAD')) {
      if (mainTip) out.push(pktLine(`${mainTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
      else if (unborn) out.push(pktLine(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
    for (const r of refs) {
      if (!keep(r.name)) continue;
      let line = `${r.oid} ${r.name}`;
      if (peel) { const peeled = peelOf(repo, r.oid); if (peeled) line += ` peeled:${peeled}`; }
      out.push(pktLine(`${line}\n`));
    }
    out.push(PKT_FLUSH);
    sendRaw(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
    return;
  }
  if (command !== 'command=fetch') {
    // v0 fetch (want/have lines) or malformed
    const hasWant = lines.some((l) => l.startsWith('want '));
    if (!hasWant) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ message: 'bad request' })); return; }
    const params = parseFetchLines(packets);
    sendRaw(res, 200, fetchResponseV0(repo, params), 'application/x-git-upload-pack-result');
    return;
  }
  const params = parseFetchLines(packets);
  sendRaw(res, 200, fetchResponseV2(repo, params), 'application/x-git-upload-pack-result');
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const { packets, rawOffset } = decodePktLines(body);
  const dataLines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  if (dataLines.length === 0) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ message: 'bad request' })); return; }
  interface Cmd { oldOid: string; newOid: string; ref: string; caps: string; }
  const commands: Cmd[] = [];
  for (const raw of dataLines) {
    const line = raw.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    const caps = nul >= 0 ? line.slice(nul + 1) : '';
    const parts = head.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string, caps });
  }
  const sideband = commands[0]?.caps.includes('side-band-64k') ?? false;
  const reportLines: string[] = [];
  let unpackOk = true; let unpackDetail = 'ok';
  const packBytes = body.subarray(rawOffset);
  const updates = commands.some((c) => c.newOid !== ZERO_OID);
  if (updates && packBytes.length === 0) {
    unpackOk = false; unpackDetail = 'unpack failed: missing packfile';
  } else if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    } catch (e) {
      unpackOk = false; unpackDetail = `unpack failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const cmd of commands) {
    if (!unpackOk) { results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' }); continue; }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      if (current === undefined) results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
      else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) results.push({ ref: cmd.ref, ok: false, reason: 'old value mismatch' });
      else { repo.refs.delete(cmd.ref); results.push({ ref: cmd.ref, ok: true, reason: '' }); }
      continue;
    }
    const obj = repo.objects.get(cmd.newOid);
    if (!obj || (obj.type !== 'commit' && obj.type !== 'tag')) { results.push({ ref: cmd.ref, ok: false, reason: 'object not found' }); continue; }
    if (current === undefined) {
      if (cmd.oldOid !== ZERO_OID) { results.push({ ref: cmd.ref, ok: false, reason: 'old value mismatch' }); continue; }
      repo.refs.set(cmd.ref, cmd.newOid);
      if (obj.type === 'commit') noteCommitOrder(cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (cmd.oldOid !== current) { results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue; }
    if (cmd.newOid === current) { results.push({ ref: cmd.ref, ok: true, reason: '' }); continue; }
    if (obj.type === 'commit' && isAncestor(repo, current, cmd.newOid)) {
      repo.refs.set(cmd.ref, cmd.newOid); noteCommitOrder(cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    } else if (obj.type === 'tag') {
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    } else {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
    }
  }
  reportLines.push(`unpack ${unpackDetail}\n`);
  for (const r of results) reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  // Report lines go in sideband band-1 packets; the response is terminated by
  // a top-level flush AFTER the sideband packets (never embedded inside them).
  const inner = pktLines(reportLines);
  const out = sideband ? Buffer.concat([sidebandWrap(inner), PKT_FLUSH]) : Buffer.concat([inner, PKT_FLUSH]);
  sendRaw(res, 200, out, 'application/x-git-receive-pack-result');
}

export async function handleGit(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, rest: string, query: URLSearchParams): Promise<boolean> {
  if (!authOk(req)) { errJson(res, 401, 'Requires authentication'); return true; }
  const repo = getRepo(owner, repoName);
  if (rest === '/info/refs') {
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { errJson(res, 400, 'invalid service'); return true; }
    if (!repo) { errJson(res, 404, 'Not Found'); return true; }
    const v2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
    const body = v2 ? v2Advertisement(service) : v0Advertisement(repo, service);
    sendRaw(res, 200, body, `application/x-${service}-advertisement`);
    return true;
  }
  if (rest === '/git-upload-pack' || rest === '/git-receive-pack') {
    if (!repo) { errJson(res, 404, 'Not Found'); return true; }
    if (rest === '/git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      await handleUploadPack(req, res, repo, v2);
    } else {
      await handleReceivePack(req, res, repo);
    }
    return true;
  }
  return false;
}
