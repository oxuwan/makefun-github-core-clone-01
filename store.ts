// In-memory forge store: repositories, git objects/refs, issues, pull requests.
import { buildTree, hashObject, parseCommit, parseTag, parseTree, ZERO_OID, type GitObject, type GitObjectType, type TreeEntry } from './gitobj.ts';
import { VIEWER } from './scenario.ts';

export const ZERO = ZERO_OID;
let repoIdSeq = 5000;
let globalIdSeq = 1;
let commitSeq = 0;
let tsSeq = 0;
export function nextTs(): number { tsSeq += 1; return 1735689600 + tsSeq; } // 2025-01-01 + seq seconds
export function isoOf(seq: number): string { return new Date(seq * 1000).toISOString(); }
export function authorLine(): string { return `${VIEWER.name} <${VIEWER.email}> ${1700000000 + commitSeq} +0000`; }

export interface Label { name: string; color: string; description: string | null; }
export interface Comment { id: number; body: string; user: { login: string }; created_at: string; updated_at: string; }
export interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; comments: Comment[]; createdSeq: number; updatedSeq: number;
  created_at: string; updated_at: string; closed_at: string | null;
}
export interface PullFile { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number; }
export interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; merged_at: string | null; merge_commit_sha: string | null;
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  baseShaAtCreate: string; files: PullFile[]; createdSeq: number;
}
export interface Repo {
  id: number; owner: string; name: string; description: string; private: boolean;
  defaultBranch: string; createdSeq: number;
  refs: Map<string, string>; objects: Map<string, GitObject>;
  labels: Map<string, Label>; issues: Map<number, Issue>; pulls: Map<number, Pull>;
  nextNumber: number; nextCommentId: number;
}

export const repos = new Map<string, Repo>();
export function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
export function getRepo(owner: string, name: string): Repo | undefined { return repos.get(repoKey(owner, name)); }
export function createRepo(owner: string, name: string, priv: boolean, description: string): Repo {
  const r: Repo = {
    id: repoIdSeq, owner, name, description, private: priv, defaultBranch: 'main',
    createdSeq: globalIdSeq, refs: new Map(), objects: new Map(),
    labels: new Map(), issues: new Map(), pulls: new Map(), nextNumber: 1, nextCommentId: 1,
  };
  repoIdSeq += 1; globalIdSeq += 1;
  repos.set(repoKey(owner, name), r);
  return r;
}
export function deleteRepo(owner: string, name: string): boolean { return repos.delete(repoKey(owner, name)); }
export function listViewerRepos(owner: string): Repo[] {
  return [...repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.createdSeq - b.createdSeq);
}

// ---- git object helpers ----
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
export function makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
  commitSeq += 1;
  const who = authorLine();
  const lines = [`tree ${treeOid}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  // Store the message verbatim: the REST /commits surface returns it exactly
  // as given, and git does not require a trailing newline.
  return putObject(repo, 'commit', Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8'));
}
export function resolveRef(repo: Repo, ref: string): string | undefined {
  if (ref === 'HEAD') return resolveRef(repo, `refs/heads/${repo.defaultBranch}`);
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
  if (repo.refs.has(`refs/tags/${ref}`)) return repo.refs.get(`refs/tags/${ref}`);
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return undefined;
}
/** Flat file map of a tree (path -> {oid, mode}). */
export function flatTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flatTree(repo, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
  return out;
}
/** Build nested trees from a flat file map; returns root tree oid. */
export function treeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node>; }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, v] of flat) {
    const segs = path.split('/'); let node = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const s = segs[i] as string;
      if (!node.dirs.has(s)) node.dirs.set(s, make());
      node = node.dirs.get(s) as Node;
    }
    node.files.set(segs[segs.length - 1] as string, v);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, v] of node.files) entries.push({ mode: v.mode, name, oid: v.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}
/** Commit objects reachable from roots (commit -> tree+parents, tag -> target, tree -> entries). */
export function reachable(repo: Repo, roots: Iterable<string>, allowMissing = false): Set<string> {
  const seen = new Set<string>(); const queue: string[] = [];
  for (const r of roots) if (/^[0-9a-f]{40}$/.test(r) && r !== ZERO_OID) queue.push(r);
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) { if (allowMissing) continue; throw new Error(`missing object ${oid}`); }
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data); queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') queue.push(parseTag(obj.data).object);
    else if (obj.type === 'tree') for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
  }
  return seen;
}
/** Is `ancestor` an ancestor of (or equal to) `descendant`? */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>(); const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue; seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      queue.push(p);
    }
  }
  return false;
}
/** Commits reachable from a tip, newest-first by creation sequence (we store seq in a side map). */
export const commitSeqMap = new Map<string, number>();
let commitOrder = 0;
export function noteCommitOrder(oid: string): void { commitOrder += 1; commitSeqMap.set(oid, commitOrder); }
export function listCommits(repo: Repo, tip: string): string[] {
  const seen = new Set<string>(); const out: string[] = []; const queue = [tip];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue; seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  out.sort((a, b) => (commitSeqMap.get(b) ?? 0) - (commitSeqMap.get(a) ?? 0));
  return out;
}
/** Line multiset diff counts. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const count = (t: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const l of t.split('\n')) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const a = count(oldText); const b = count(newText);
  let additions = 0; let deletions = 0;
  for (const [l, n] of b) additions += Math.max(0, n - (a.get(l) ?? 0));
  for (const [l, n] of a) deletions += Math.max(0, n - (b.get(l) ?? 0));
  return { additions, deletions };
}
export function diffFlat(repo: Repo, baseFlat: Map<string, { oid: string; mode: string }>, headFlat: Map<string, { oid: string; mode: string }>): PullFile[] {
  const files: PullFile[] = [];
  const names = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const name of [...names].sort()) {
    const b = baseFlat.get(name); const h = headFlat.get(name);
    if (b && h && b.oid === h.oid) continue;
    if (!b && h) {
      const data = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const lines = data === '' ? 0 : data.split('\n').length;
      files.push({ filename: name, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (b && !h) {
      const data = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const lines = data === '' ? 0 : data.split('\n').length;
      files.push({ filename: name, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else if (b && h) {
      const oldT = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const newT = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const d = lineDiff(oldT, newT);
      files.push({ filename: name, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
    }
  }
  return files;
}
/** Peel a ref to its commit (tags peel). */
export function peelToCommit(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj) return cur;
    if (obj.type === 'tag') { cur = parseTag(obj.data).object; continue; }
    return cur;
  }
  return cur;
}
