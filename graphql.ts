// GraphQL v4: a small executor for the documents gh / github-mcp-server send.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getRepo, isoOf, nextTs, type Issue, type Pull, type Repo } from './store.ts';
import { VIEWER_LOGIN } from './scenario.ts';
import { authOk, createIssueInRepo, createPullInRepo, errJson, gid, isObj, mergePull, parseGid, parseJsonBody, prMergeable, readBody, sendJson } from './common.ts';

// ---------- parser ----------
type GValue = string | number | boolean | null | GValue[] | { [k: string]: GValue } | { __var: string } | { __enum: string };
interface FieldNode { name: string; alias: string; args: Record<string, GValue>; children: FieldNode[]; fragType: string | null; }
interface Operation { kind: string; name: string | null; vars: Record<string, GValue>; selections: FieldNode[]; }
function tokenize(src: string): string[] {
  const toks: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c) || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '"') {
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; } else { out += src[j]; j += 1; } }
      toks.push(JSON.stringify(out)); i = j + 1; continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') { toks.push('...'); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(c)) { toks.push(c); i += 1; continue; }
    if (/[A-Za-z_0-9-]/.test(c)) { let j = i; while (j < src.length && /[A-Za-z_0-9-]/.test(src[j] as string)) j += 1; toks.push(src.slice(i, j)); i = j; continue; }
    i += 1;
  }
  return toks;
}
class Parser {
  toks: string[]; pos = 0;
  constructor(src: string) { this.toks = tokenize(src); }
  peek(): string { return this.toks[this.pos] ?? ''; }
  next(): string { return this.toks[this.pos++] ?? ''; }
  expect(t: string): void { if (this.next() !== t) throw new Error(`expected ${t}`); }
  parseValue(): GValue {
    const t = this.next();
    if (t === '$') return { __var: this.next() };
    if (t === '[') { const arr: GValue[] = []; while (this.peek() !== ']') arr.push(this.parseValue()); this.next(); return arr; }
    if (t === '{') { const obj: Record<string, GValue> = {}; while (this.peek() !== '}') { const k = this.next(); this.expect(':'); obj[k] = this.parseValue(); } this.next(); return obj; }
    if (t.startsWith('"')) return JSON.parse(t) as string;
    if (t === 'true') return true; if (t === 'false') return false; if (t === 'null') return null;
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
    if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
    return { __enum: t };
  }
  parseArgs(): Record<string, GValue> {
    const args: Record<string, GValue> = {};
    if (this.peek() !== '(') return args;
    this.next();
    while (this.peek() !== ')') { const k = this.next(); this.expect(':'); args[k] = this.parseValue(); }
    this.next();
    return args;
  }
  parseSelections(fragType: string | null = null): FieldNode[] {
    this.expect('{');
    const out: FieldNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') { this.next(); const typeName = this.next(); out.push(...this.parseSelections(typeName)); }
        else { this.next(); /* named fragment: skip its selections (documents here use inline only) */ if (this.peek() === '{') this.parseSelections(null); }
        continue;
      }
      let name = this.next();
      let alias = name;
      if (this.peek() === ':') { this.next(); alias = name; name = this.next(); }
      const args = this.parseArgs();
      const children = this.peek() === '{' ? this.parseSelections(null) : [];
      out.push({ name, alias, args, children, fragType });
    }
    this.next();
    return out;
  }
  parseOperation(): Operation {
    let kind = 'query'; let name: string | null = null;
    const t = this.peek();
    if (t === 'query' || t === 'mutation') { kind = this.next(); if (this.peek() !== '{' && this.peek() !== '(') name = this.next(); }
    const vars: Record<string, GValue> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const dollar = this.next(); void dollar;
        const vname = this.next(); this.expect(':'); this.parseValue(); // type (ignored, may include ! and [ ])
        while (this.peek() !== ')' && this.peek() !== '$' && this.peek() !== ',') this.next();
        vars[vname] = null;
      }
      this.next();
    }
    const selections = this.parseSelections(null);
    return { kind, name, vars, selections };
  }
}

// ---------- schema info ----------
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'comments', 'createdAt', 'updatedAt', 'url', 'labels', 'closed', 'closedAt'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'headRef', 'baseRef'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt'],
  User: ['login', 'id', 'name', 'email'],
  SearchType: [],
};
const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------- execution ----------
interface Ctx { errors: { message: string }[]; }
function resolveVal(v: GValue, vars: Record<string, unknown>): unknown {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    if ('__var' in v) return vars[(v as { __var: string }).__var];
    if ('__enum' in v) return (v as { __enum: string }).__enum;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = resolveVal(val as GValue, vars);
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => resolveVal(x, vars));
  return v;
}
function resolveArgs(f: FieldNode, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f.args)) out[k] = resolveVal(v, vars);
  return out;
}
type GObj =
  | { __type: 'User'; login: string }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'Ref'; name: string }
  | { __type: 'IssueConnection'; repo: Repo; issues: Issue[]; hasNext: boolean; endCursor: string | null }
  | { __type: 'PullConnection'; repo: Repo; pulls: Pull[] }
  | { __type: 'PullFiles'; repo: Repo; pull: Pull }
  | { __type: 'TypeInfo'; name: string }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'CommentEdge'; id: string; body: string }
  | { __type: 'MutationResult'; [k: string]: unknown };

function repoGid(r: Repo): string { return gid('Repository', `${r.owner}/${r.name}`); }
function issueGid(r: Repo, i: Issue): string { return gid('Issue', `${r.owner}/${r.name}:${i.number}`); }
function pullGid(r: Repo, p: Pull): string { return gid('PullRequest', `${r.owner}/${r.name}:${p.number}`); }

function execSelections(obj: GObj, fields: FieldNode[], vars: Record<string, unknown>, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeName = obj.__type === 'TypeInfo' ? '__Type' : obj.__type;
  const known = TYPE_FIELDS[typeName] ?? null;
  for (const f of fields) {
    if (f.fragType !== null) {
      const want = f.fragType;
      const actual = obj.__type === 'Repository' ? 'Repository' : obj.__type === 'Issue' ? 'Issue' : obj.__type === 'PullRequest' ? 'PullRequest' : obj.__type;
      if (want !== actual) continue;
    }
    if (known !== null && !known.includes(f.name) && obj.__type !== 'TypeInfo') {
      ctx.errors.push({ message: `Cannot query field "${f.name}" on type "${typeName}".` });
      out[f.alias] = null;
      continue;
    }
    out[f.alias] = execField(obj, f, vars, ctx);
  }
  return out;
}
function issueState(i: Issue): string { return i.state === 'open' ? 'OPEN' : 'CLOSED'; }
function pullState(p: Pull): string { return p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED'; }

function execField(obj: GObj, f: FieldNode, vars: Record<string, unknown>, ctx: Ctx): unknown {
  const args = resolveArgs(f, vars);
  switch (obj.__type) {
    case 'User': return f.name === 'login' ? obj.login : f.name === 'id' ? gid('User', obj.login) : null;
    case 'Ref': return f.name === 'name' ? obj.name : null;
    case 'PageInfo': return f.name === 'hasNextPage' ? obj.hasNextPage : f.name === 'endCursor' ? obj.endCursor : null;
    case 'CommentEdge': return f.name === 'id' ? obj.id : f.name === 'body' ? obj.body : null;
    case 'TypeInfo': {
      if (f.name === 'name') return obj.name;
      if (f.name === 'kind') return TYPE_ENUMS[obj.name] ? 'ENUM' : 'OBJECT';
      if (f.name === 'fields') return (TYPE_FIELDS[obj.name] ?? []).map((n) => ({ name: n }));
      if (f.name === 'enumValues') return (TYPE_ENUMS[obj.name] ?? []).map((n) => ({ name: n }));
      return null;
    }
    case 'Repository': {
      const r = obj.repo;
      switch (f.name) {
        case 'id': return repoGid(r);
        case 'databaseId': return r.id;
        case 'name': return r.name;
        case 'nameWithOwner': return `${r.owner}/${r.name}`;
        case 'owner': return execSelections({ __type: 'User', login: r.owner }, f.children, vars, ctx);
        case 'defaultBranchRef': {
          const tip = r.refs.get(`refs/heads/${r.defaultBranch}`);
          return tip === undefined ? null : execSelections({ __type: 'Ref', name: r.defaultBranch }, f.children, vars, ctx);
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return r.description;
        case 'issue': {
          const num = args.number as number;
          const issue = r.issues.get(num);
          return issue === undefined ? null : execSelections({ __type: 'Issue', repo: r, issue }, f.children, vars, ctx);
        }
        case 'issues': {
          const list = issuesConnection(r, args);
          return execSelections({ __type: 'IssueConnection', repo: r, issues: list.nodes, hasNext: list.hasNext, endCursor: list.endCursor }, f.children, vars, ctx);
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? args.first : 100;
          const pulls = [...r.pulls.values()].filter((p) => p.state === 'open').sort((a, b) => b.createdSeq - a.createdSeq).slice(0, first);
          return execSelections({ __type: 'PullConnection', repo: r, pulls }, f.children, vars, ctx);
        }
        case 'pullRequest': {
          const pull = r.pulls.get(args.number as number);
          return pull === undefined ? null : execSelections({ __type: 'PullRequest', repo: r, pull }, f.children, vars, ctx);
        }
        default: return null;
      }
    }
    case 'Issue': {
      const i = obj.issue;
      switch (f.name) {
        case 'id': return issueGid(obj.repo, i);
        case 'number': return i.number;
        case 'title': return i.title;
        case 'state': return issueState(i);
        case 'body': return i.body;
        default: return null;
      }
    }
    case 'IssueConnection': {
      switch (f.name) {
        case 'nodes': return obj.issues.map((i) => execSelections({ __type: 'Issue', repo: obj.repo, issue: i }, f.children, vars, ctx));
        case 'pageInfo': return execSelections({ __type: 'PageInfo', hasNextPage: obj.hasNext, endCursor: obj.endCursor }, f.children, vars, ctx);
        case 'totalCount': return obj.issues.length;
        default: return null;
      }
    }
    case 'PullConnection': {
      if (f.name === 'nodes') return obj.pulls.map((p) => execSelections({ __type: 'PullRequest', repo: obj.repo, pull: p }, f.children, vars, ctx));
      return null;
    }
    case 'PullRequest': {
      const p = obj.pull;
      switch (f.name) {
        case 'id': return pullGid(obj.repo, p);
        case 'number': return p.number;
        case 'state': return pullState(p);
        case 'merged': return p.merged;
        case 'headRefName': return p.headRef;
        case 'baseRefName': return p.baseRef;
        case 'mergeable': return prMergeable(obj.repo, p);
        case 'title': return p.title;
        case 'body': return p.body;
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : 100;
          const nodes = p.files.slice(0, first).map((fl) => ({ path: fl.filename }));
          const out: Record<string, unknown> = {};
          for (const child of f.children) {
            if (child.name === 'nodes') out[child.alias] = nodes.map((n) => { const o: Record<string, unknown> = {}; for (const c of child.children) o[c.alias] = c.name === 'path' ? n.path : null; return o; });
            else out[child.alias] = null;
          }
          return out;
        }
        default: return null;
      }
    }
    case 'PullFiles': return null;
    case 'MutationResult': return (obj as Record<string, unknown>)[f.name] ?? null;
    default: return null;
  }
}
function issuesConnection(r: Repo, args: Record<string, unknown>): { nodes: Issue[]; hasNext: boolean; endCursor: string | null } {
  let list = [...r.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length) {
    const want = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => want.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy && orderBy.field === 'CREATED_AT') {
    list.sort((a, b) => orderBy.direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq);
  } else {
    list.sort((a, b) => a.createdSeq - b.createdSeq);
  }
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    try {
      const decoded = Buffer.from(args.after, 'base64').toString('utf8');
      const num = parseInt(decoded.replace('cursor:', ''), 10);
      const idx = list.findIndex((i) => i.number === num);
      if (idx >= 0) start = idx + 1;
    } catch { /* ignore */ }
  }
  const first = typeof args.first === 'number' ? args.first : 100;
  const nodes = list.slice(start, start + first);
  const hasNext = start + first < list.length;
  const endCursor = nodes.length ? Buffer.from(`cursor:${nodes[nodes.length - 1]?.number}`, 'utf8').toString('base64') : null;
  return { nodes, hasNext, endCursor };
}

function findRepoByGid(id: string): Repo | null {
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'Repository') return null;
  const [owner, name] = parsed.key.split('/');
  if (!owner || !name) return null;
  return getRepo(owner, name) ?? null;
}
function findIssueByGid(id: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'Issue') return null;
  const m = /^(.+)\/([^/]+):(\d+)$/.exec(parsed.key);
  if (!m) return null;
  const repo = getRepo(m[1] as string, m[2] as string);
  if (!repo) return null;
  const issue = repo.issues.get(parseInt(m[3] as string, 10));
  return issue ? { repo, issue } : null;
}
function findPullByGid(id: string): { repo: Repo; pull: Pull } | null {
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'PullRequest') return null;
  const m = /^(.+)\/([^/]+):(\d+)$/.exec(parsed.key);
  if (!m) return null;
  const repo = getRepo(m[1] as string, m[2] as string);
  if (!repo) return null;
  const pull = repo.pulls.get(parseInt(m[3] as string, 10));
  return pull ? { repo, pull } : null;
}

function execOperation(op: Operation, vars: Record<string, unknown>): { data: Record<string, unknown>; errors: { message: string }[] } {
  const ctx: Ctx = { errors: [] };
  const data: Record<string, unknown> = {};
  for (const f of op.selections) {
    const args = resolveArgs(f, vars);
    if (op.kind === 'mutation') {
      data[f.alias] = execMutation(f, args, vars, ctx);
      continue;
    }
    if (f.name === 'viewer') {
      data[f.alias] = execSelections({ __type: 'User', login: VIEWER_LOGIN }, f.children, vars, ctx);
    } else if (f.name === 'repository') {
      const repo = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (!repo) data[f.alias] = null;
      else if (String(args.owner) !== VIEWER_LOGIN) data[f.alias] = null;
      else data[f.alias] = execSelections({ __type: 'Repository', repo }, f.children, vars, ctx);
    } else if (f.name === 'node') {
      const id = String(args.id ?? '');
      const parsed = parseGid(id);
      let obj: GObj | null = null;
      if (parsed?.kind === 'Repository') { const repo = findRepoByGid(id); if (repo) obj = { __type: 'Repository', repo }; }
      else if (parsed?.kind === 'Issue') { const found = findIssueByGid(id); if (found) obj = { __type: 'Issue', repo: found.repo, issue: found.issue }; }
      else if (parsed?.kind === 'PullRequest') { const found = findPullByGid(id); if (found) obj = { __type: 'PullRequest', repo: found.repo, pull: found.pull }; }
      data[f.alias] = obj === null ? null : execSelections(obj, f.children, vars, ctx);
    } else if (f.name === '__type') {
      const name = String(args.name ?? '');
      data[f.alias] = execSelections({ __type: 'TypeInfo', name }, f.children, vars, ctx);
    } else {
      ctx.errors.push({ message: `Cannot query field "${f.name}" on type "Query".` });
      data[f.alias] = null;
    }
  }
  return { data, errors: ctx.errors };
}
function execMutation(f: { name: string; alias: string; children: { name: string; alias: string; children: never[]; args: Record<string, GValue>; fragType: string | null }[] }, args: Record<string, unknown>, vars: Record<string, unknown>, ctx: Ctx): unknown {
  const input = isObj(args.input) ? args.input : {};
  const out: Record<string, unknown> = {};
  const sel = (name: string): { name: string; alias: string; children: never[]; args: Record<string, GValue>; fragType: string | null } | undefined => f.children.find((c) => c.name === name);
  if (f.name === 'createIssue') {
    const repo = findRepoByGid(String(input.repositoryId ?? ''));
    if (!repo) { ctx.errors.push({ message: 'repository not found' }); return null; }
    const issue = createIssueInRepo(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
    const node = sel('issue');
    if (node) out[node.alias] = execSelections({ __type: 'Issue', repo, issue }, node.children as never as Parameters<typeof execSelections>[1], vars, ctx);
    return out;
  }
  if (f.name === 'closeIssue') {
    const found = findIssueByGid(String(input.issueId ?? ''));
    if (!found) { ctx.errors.push({ message: 'issue not found' }); return null; }
    found.issue.state = 'closed'; found.issue.closed_at = isoOf(nextTs());
    const node = sel('issue');
    if (node) out[node.alias] = execSelections({ __type: 'Issue', repo: found.repo, issue: found.issue }, node.children as never as Parameters<typeof execSelections>[1], vars, ctx);
    return out;
  }
  if (f.name === 'createPullRequest') {
    const repo = findRepoByGid(String(input.repositoryId ?? ''));
    if (!repo) { ctx.errors.push({ message: 'repository not found' }); return null; }
    const created = createPullInRepo(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', String(input.headRefName ?? ''), String(input.baseRefName ?? 'main'));
    if ('error' in created) { ctx.errors.push({ message: created.error }); return null; }
    const node = sel('pullRequest');
    if (node) out[node.alias] = execSelections({ __type: 'PullRequest', repo, pull: created }, node.children as never as Parameters<typeof execSelections>[1], vars, ctx);
    return out;
  }
  if (f.name === 'mergePullRequest') {
    const found = findPullByGid(String(input.pullRequestId ?? ''));
    if (!found) { ctx.errors.push({ message: 'pull request not found' }); return null; }
    mergePull(found.repo, found.pull);
    const node = sel('pullRequest');
    if (node) out[node.alias] = execSelections({ __type: 'PullRequest', repo: found.repo, pull: found.pull }, node.children as never as Parameters<typeof execSelections>[1], vars, ctx);
    return out;
  }
  if (f.name === 'addComment') {
    const found = findIssueByGid(String(input.subjectId ?? ''));
    if (!found) { ctx.errors.push({ message: 'subject not found' }); return null; }
    const commentId = found.repo.nextCommentId;
    found.repo.nextCommentId += 1;
    const bodyText = String(input.body ?? '');
    const stamp = isoOf(nextTs());
    found.issue.comments.push({ id: commentId, body: bodyText, user: { login: VIEWER_LOGIN }, created_at: stamp, updated_at: stamp });
    const node = sel('commentEdge');
    if (node) {
      const edgeOut: Record<string, unknown> = {};
      for (const c of node.children) {
        if (c.name === 'node') {
          const nOut: Record<string, unknown> = {};
          for (const gc of c.children) nOut[gc.alias] = gc.name === 'id' ? gid('Comment', `${found.repo.owner}/${found.repo.name}:${found.issue.number}:${commentId}`) : gc.name === 'body' ? bodyText : null;
          edgeOut[c.alias] = nOut;
        }
      }
      out[node.alias] = edgeOut;
    }
    return out;
  }
  ctx.errors.push({ message: `Unknown mutation "${f.name}".` });
  return null;
}

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!authOk(req)) { errJson(res, 401, 'Requires authentication'); return true; }
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) { errJson(res, 400, 'Invalid JSON body'); return true; }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (!isObj(doc) || typeof doc.query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
    const vars = isObj(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    let op: Operation;
    try { op = new Parser(doc.query).parseOperation(); } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : 'parse error' }] };
    }
    const { data, errors } = execOperation(op, vars);
    return errors.length ? { data, errors } : { data };
  };
  if (Array.isArray(parsed.value)) sendJson(res, 200, parsed.value.map(runOne));
  else sendJson(res, 200, runOne(parsed.value));
  return true;
}
