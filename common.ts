// Shared helpers: auth, JSON replies, serializers, contents commits, PR merge.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, VIEWER_LOGIN } from './scenario.ts';
import { diffFlat, flatTree, isoOf, listCommits, makeCommit, nextTs, noteCommitOrder, peelToCommit, putObject, reachable, resolveRef, treeFromFlat, type Issue, type Label, type Pull, type Repo } from './store.ts';
import { parseCommit } from './gitobj.ts';

export const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
export const VIEWER_LOGIN_VALUE = VIEWER_LOGIN;
let reqSeq = 0;
export function nextReqId(): string { reqSeq += 1; return `req-${reqSeq.toString(16).padStart(8, '0')}`; }

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': nextReqId(), ...extra };
  if (status !== 204) headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}
export function sendRaw(res: ServerResponse, status: number, buf: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': buf.length, 'x-github-request-id': nextReqId() });
  res.end(buf);
}
export function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}
export function authOk(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return false;
  const tok = h.slice(7);
  if (tok === '') return false;
  if (TOKEN === '') return true; // local run without a configured token: any non-empty bearer
  return tok === TOKEN;
}
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { chunks.push(c); if (Buffer.concat(chunks).length > 64 * 1024 * 1024) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
/** Parse a JSON body; returns {ok:false} when present-but-malformed (caller sends 400). */
export function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(buf.toString('utf8')) }; } catch { return { ok: false }; }
}
export function isObj(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
export function queryOf(req: IncomingMessage): URLSearchParams {
  try { return new URL(req.url ?? '/', 'http://x').searchParams; } catch { return new URLSearchParams(); }
}
export function pathOf(req: IncomingMessage): string {
  try { return decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname); } catch { return '/'; }
}

// ---- serializers ----
export function userJson(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER_LOGIN ? VIEWER.id : 1000, avatar_url: '', type: 'User', site_admin: false };
}
export function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.id, name: r.name, full_name: `${r.owner}/${r.name}`,
    owner: userJson(r.owner), private: r.private, description: r.description,
    default_branch: r.defaultBranch, html_url: `https://example.invalid/${r.owner}/${r.name}`,
    url: `/api/v3/repos/${r.owner}/${r.name}`, created_at: isoOf(1735689600 + r.createdSeq),
    updated_at: isoOf(1735689600 + r.createdSeq), pushed_at: isoOf(1735689600 + r.createdSeq),
    has_issues: true, has_projects: true, has_wiki: true, fork: false, archived: false,
    open_issues_count: [...r.issues.values()].filter((i) => i.state === 'open').length,
    license: null, topics: [], visibility: r.private ? 'private' : 'public',
  };
}
export function labelJson(l: Label): Record<string, unknown> {
  return { id: 0, name: l.name, color: l.color, description: l.description, default: false, url: '' };
}
export function issueJson(r: Repo, i: Issue): Record<string, unknown> {
  return {
    id: i.id, number: i.number, title: i.title, body: i.body, state: i.state,
    labels: i.labels.map(labelJson), user: userJson(VIEWER_LOGIN), assignee: null, assignees: [],
    comments: i.comments.length, created_at: i.created_at, updated_at: i.updated_at, closed_at: i.closed_at,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}`,
    html_url: `https://example.invalid/${r.owner}/${r.name}/issues/${i.number}`,
    repository_url: `/api/v3/repos/${r.owner}/${r.name}`, locked: false,
  };
}
export function pullJson(r: Repo, p: Pull): Record<string, unknown> {
  return {
    id: p.id, number: p.number, title: p.title, body: p.body, state: p.state,
    merged: p.merged, merged_at: p.merged_at, merge_commit_sha: p.merge_commit_sha,
    head: { ref: p.headRef, sha: p.headSha, label: `${r.owner}:${p.headRef}`, user: userJson(r.owner), repo: repoJson(r) },
    base: { ref: p.baseRef, sha: p.baseSha, label: `${r.owner}:${p.baseRef}`, user: userJson(r.owner), repo: repoJson(r) },
    user: userJson(VIEWER_LOGIN), created_at: isoOf(1735689600 + p.createdSeq),
    updated_at: isoOf(1735689600 + p.createdSeq), closed_at: p.state === 'closed' ? p.merged_at : null,
    mergeable: prMergeable(r, p) === 'MERGEABLE',
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
    html_url: `https://example.invalid/${r.owner}/${r.name}/pulls/${p.number}`,
  };
}
export function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}
export function parseGid(id: string): { kind: string; key: string } | null {
  try {
    const s = Buffer.from(id, 'base64').toString('utf8');
    const i = s.indexOf(':');
    if (i <= 0) return null;
    return { kind: s.slice(0, i), key: s.slice(i + 1) };
  } catch { return null; }
}

// ---- contents commits ----
export interface CommitFileResult { commitSha: string; blobSha: string; created: boolean; branch: string; }
export function commitFile(repo: Repo, branchName: string | undefined, path: string, content: Buffer, message: string, remove = false): CommitFileResult {
  const branch = branchName ?? repo.defaultBranch;
  let tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) {
    // New branch from the default branch tip (or unborn).
    const defTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    tip = defTip;
  }
  const baseFlat = tip === undefined ? new Map() : flatTree(repo, parseCommit(repo.objects.get(peelToCommit(repo, tip))?.data ?? Buffer.alloc(0)).tree);
  const blobSha = putObject(repo, 'blob', content);
  const flat = new Map(baseFlat);
  if (remove) flat.delete(path); else flat.set(path, { oid: blobSha, mode: '100644' });
  const created = !baseFlat.has(path) && !remove;
  const treeOid = treeFromFlat(repo, flat);
  const parents = tip === undefined ? [] : [peelToCommit(repo, tip)];
  const commitSha = makeCommit(repo, treeOid, parents, message);
  noteCommitOrder(commitSha);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha, created, branch };
}
export function fileAt(repo: Repo, ref: string | undefined, path: string): { oid: string; data: Buffer; mode: string } | null {
  const tip = ref === undefined ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : resolveRef(repo, ref);
  if (tip === undefined) return null;
  const commitObj = repo.objects.get(peelToCommit(repo, tip));
  if (!commitObj) return null;
  const flat = flatTree(repo, parseCommit(commitObj.data).tree);
  const e = flat.get(path);
  if (!e) return null;
  const blob = repo.objects.get(e.oid);
  if (!blob) return null;
  return { oid: e.oid, data: blob.data, mode: e.mode };
}
export function dirAt(repo: Repo, ref: string | undefined, dirPath: string): { name: string; path: string; sha: string; type: 'file' | 'dir' }[] | null {
  const tip = ref === undefined ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : resolveRef(repo, ref);
  if (tip === undefined) return null;
  const commitObj = repo.objects.get(peelToCommit(repo, tip));
  if (!commitObj) return null;
  const flat = flatTree(repo, parseCommit(commitObj.data).tree);
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const seen = new Map<string, { name: string; path: string; sha: string; type: 'file' | 'dir' }>();
  for (const [p, v] of flat) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash < 0) seen.set(rest, { name: rest, path: p, sha: v.oid, type: 'file' });
    else {
      const dir = rest.slice(0, slash);
      if (!seen.has(dir)) {
        const sub = new Map<string, { oid: string; mode: string }>();
        for (const [pp, vv] of flat) if (pp.startsWith(`${prefix}${dir}/`)) sub.set(pp.slice(prefix.length + dir.length + 1), vv);
        seen.set(dir, { name: dir, path: prefix + dir, sha: treeFromFlat(repo, sub), type: 'dir' });
      }
    }
  }
  if (seen.size === 0) return null;
  return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

// ---- pull requests ----
export function prMergeable(r: Repo, p: Pull): 'MERGEABLE' | 'CONFLICTING' {
  if (p.state !== 'open') return 'CONFLICTING';
  const baseTip = r.refs.get(`refs/heads/${p.baseRef}`);
  if (baseTip === undefined) return 'CONFLICTING';
  const headTip = r.refs.get(`refs/heads/${p.headRef}`);
  if (headTip === undefined || headTip !== p.headSha) return 'CONFLICTING';
  // Conflict: base moved after creation AND both sides changed the same path differently.
  const baseAtCreate = flatTree(r, parseCommit(r.objects.get(peelToCommit(r, p.baseShaAtCreate))?.data ?? Buffer.alloc(0)).tree);
  const baseNow = flatTree(r, parseCommit(r.objects.get(peelToCommit(r, baseTip))?.data ?? Buffer.alloc(0)).tree);
  const headFlat = flatTree(r, parseCommit(r.objects.get(peelToCommit(r, p.headSha))?.data ?? Buffer.alloc(0)).tree);
  for (const f of p.files) {
    const a = baseAtCreate.get(f.filename)?.oid; const b = baseNow.get(f.filename)?.oid; const h = headFlat.get(f.filename)?.oid;
    if (b !== a && h !== a && h !== b) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}
export function mergePull(r: Repo, p: Pull): { ok: boolean; sha?: string; reason?: string } {
  if (p.state !== 'open') return { ok: false, reason: 'already closed' };
  if (prMergeable(r, p) !== 'MERGEABLE') return { ok: false, reason: 'conflict' };
  const baseTip = r.refs.get(`refs/heads/${p.baseRef}`) as string;
  const baseFlat = flatTree(r, parseCommit(r.objects.get(peelToCommit(r, baseTip))?.data ?? Buffer.alloc(0)).tree);
  const headFlat = flatTree(r, parseCommit(r.objects.get(peelToCommit(r, p.headSha))?.data ?? Buffer.alloc(0)).tree);
  const merged = new Map(baseFlat);
  for (const f of p.files) {
    const h = headFlat.get(f.filename);
    if (h) merged.set(f.filename, h); else merged.delete(f.filename);
  }
  const treeOid = treeFromFlat(r, merged);
  const msg = `Merge pull request #${p.number} from ${r.owner}/${p.headRef}\n\n${p.title}`;
  const sha = makeCommit(r, treeOid, [peelToCommit(r, baseTip)], msg);
  noteCommitOrder(sha);
  r.refs.set(`refs/heads/${p.baseRef}`, sha);
  p.state = 'closed'; p.merged = true; p.merged_at = isoOf(nextTs()); p.merge_commit_sha = sha; p.baseSha = sha;
  return { ok: true, sha };
}
export function createIssueInRepo(r: Repo, title: string, body: string, labels: Label[]): Issue {
  const seq = nextTs();
  const issue: Issue = {
    id: 100000 + r.id * 1000 + r.nextNumber, number: r.nextNumber, title, body, state: 'open',
    labels: [...labels], comments: [], createdSeq: seq, updatedSeq: seq,
    created_at: isoOf(seq), updated_at: isoOf(seq), closed_at: null,
  };
  r.nextNumber += 1;
  r.issues.set(issue.number, issue);
  return issue;
}
export function createPullInRepo(r: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
  const headSha = r.refs.get(`refs/heads/${head}`);
  const baseSha = r.refs.get(`refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) return { error: 'branch not found' };
  for (const p of r.pulls.values()) if (p.headRef === head && p.baseRef === base && p.state === 'open') return { error: 'pull request already exists' };
  const seq = nextTs();
  const baseFlat = flatTree(r, parseCommit(r.objects.get(peelToCommit(r, baseSha))?.data ?? Buffer.alloc(0)).tree);
  const headFlat = flatTree(r, parseCommit(r.objects.get(peelToCommit(r, headSha))?.data ?? Buffer.alloc(0)).tree);
  const pull: Pull = {
    id: 200000 + r.id * 1000 + r.nextNumber, number: r.nextNumber, title, body, state: 'open',
    merged: false, merged_at: null, merge_commit_sha: null,
    headRef: head, baseRef: base, headSha: peelToCommit(r, headSha), baseSha: peelToCommit(r, baseSha),
    baseShaAtCreate: peelToCommit(r, baseSha), files: diffFlat(r, baseFlat, headFlat), createdSeq: seq,
  };
  r.nextNumber += 1;
  r.pulls.set(pull.number, pull);
  return pull;
}
export function listCommitsForRef(r: Repo, ref: string | undefined): { sha: string; message: string; tree: string }[] {
  const tip = ref === undefined ? r.refs.get(`refs/heads/${r.defaultBranch}`) : resolveRef(r, ref);
  if (tip === undefined) return [];
  return listCommits(r, peelToCommit(r, tip)).map((sha) => {
    const c = parseCommit(r.objects.get(sha)?.data ?? Buffer.alloc(0));
    return { sha, message: c.message, tree: c.tree };
  });
}
