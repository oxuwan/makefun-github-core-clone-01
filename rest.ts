// GitHub REST v3 routes under /api/v3.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRepo, deleteRepo, getRepo, isoOf, listViewerRepos, nextTs, type Repo } from './store.ts';
import { VIEWER_LOGIN } from './scenario.ts';
import { authOk, commitFile, createIssueInRepo, createPullInRepo, dirAt, errJson, fileAt, gid, isObj, issueJson, labelJson, listCommitsForRef, mergePull, parseJsonBody, pathOf, prMergeable, pullJson, queryOf, readBody, repoJson, sendJson, userJson } from './common.ts';
import { parseCommit } from './gitobj.ts';

function linkHeader(req: IncomingMessage, path: string, page: number, perPage: number, total: number): string {
  const host = req.headers.host ?? 'localhost';
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const url = (p: number): string => `http://${host}${path}?page=${p}&per_page=${perPage}`;
  const parts: string[] = [];
  if (page < lastPage) parts.push(`<${url(page + 1)}>; rel="next"`, `<${url(lastPage)}>; rel="last"`);
  if (page > 1) parts.push(`<${url(1)}>; rel="first"`, `<${url(page - 1)}>; rel="prev"`);
  return parts.join(', ');
}
function paginate<T>(req: IncomingMessage, path: string, items: T[], q: URLSearchParams): { page: T[]; link: string } {
  const perPage = Math.min(100, Math.max(1, parseInt(q.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), link: linkHeader(req, path, page, perPage, items.length) };
}
function needRepo(res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) { errJson(res, 404, 'Not Found'); return null; }
  const r = getRepo(owner, name);
  if (!r) { errJson(res, 404, 'Not Found'); return null; }
  return r;
}

export async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  if (!path.startsWith('/api/v3')) return false;
  const method = req.method ?? 'GET';
  const sub = path === '/api/v3' ? '/' : path.slice('/api/v3'.length);
  const q = queryOf(req);

  // API root (public, like api.github.com).
  if ((sub === '/' || sub === '') && method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (!authOk(req)) { errJson(res, 401, 'Requires authentication'); return true; }

  // Body for mutating methods.
  let body: unknown = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) { errJson(res, 400, 'Invalid JSON body'); return true; }
    body = parsed.value;
  }
  const b = isObj(body) ? body : {};

  const seg = sub.split('/').filter((s) => s !== '');
  const apiPath = `/api/v3${sub}`;

  // GET /meta
  if (method === 'GET' && sub === '/meta') { sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true }); return true; }
  // GET /user
  if (method === 'GET' && sub === '/user') {
    sendJson(res, 200, { ...userJson(VIEWER_LOGIN), name: 'Forge User', email: `${VIEWER_LOGIN}@example.invalid`, type: 'User', site_admin: false, created_at: '2025-01-01T00:00:00Z' });
    return true;
  }
  // POST /user/repos ; GET /user/repos
  if (sub === '/user/repos') {
    if (method === 'POST') {
      const name = typeof b.name === 'string' ? b.name : '';
      if (name === '') { errJson(res, 422, 'name is required'); return true; }
      if (getRepo(VIEWER_LOGIN, name)) { errJson(res, 422, 'Repository already exists'); return true; }
      const r = createRepo(VIEWER_LOGIN, name, b.private === true, typeof b.description === 'string' ? b.description : '');
      sendJson(res, 201, repoJson(r));
      return true;
    }
    if (method === 'GET') {
      const all = listViewerRepos(VIEWER_LOGIN);
      const { page, link } = paginate(req, apiPath, all, q);
      const extra: Record<string, string> = {};
      if (link) extra.link = link;
      sendJson(res, 200, page.map(repoJson), extra);
      return true;
    }
  }
  // /repos/{owner}/{name}/...
  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = seg[1] as string; const name = seg[2] as string;
    const restSeg = seg.slice(3);
    // GET /repos/{o}/{r}  PATCH  DELETE
    if (restSeg.length === 0) {
      if (method === 'GET') { const r = needRepo(res, owner, name); if (r) sendJson(res, 200, repoJson(r)); return true; }
      if (method === 'PATCH') {
        const r = needRepo(res, owner, name); if (!r) return true;
        if (typeof b.description === 'string') r.description = b.description;
        if (typeof b.private === 'boolean') r.private = b.private;
        sendJson(res, 200, repoJson(r)); return true;
      }
      if (method === 'DELETE') {
        const r = needRepo(res, owner, name); if (!r) return true;
        deleteRepo(owner, name);
        sendJson(res, 204, null); return true;
      }
      errJson(res, 404, 'Not Found'); return true;
    }
    const r = needRepo(res, owner, name);
    if (!r) return true;
    const tail = restSeg.join('/');

    // branches
    if (restSeg[0] === 'branches') {
      if (method === 'GET' && restSeg.length === 1) {
        const list = [...r.refs.entries()].filter(([n]) => n.startsWith('refs/heads/')).map(([n, oid]) => ({ name: n.slice('refs/heads/'.length), commit: { sha: oid, url: '' }, protected: false }));
        sendJson(res, 200, list); return true;
      }
      if (method === 'GET' && restSeg.length === 2) {
        const oid = r.refs.get(`refs/heads/${restSeg[1]}`);
        if (!oid) { errJson(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, { name: restSeg[1], commit: { sha: oid, url: '' }, protected: false }); return true;
      }
    }
    // commits
    if (restSeg[0] === 'commits' && method === 'GET' && restSeg.length === 1) {
      const list = listCommitsForRef(r, q.get('sha') ?? undefined).map((c) => ({
        sha: c.sha, commit: { message: c.message, author: { name: 'Forge User', email: `${VIEWER_LOGIN}@example.invalid`, date: '2025-01-01T00:00:00Z' }, committer: { name: 'Forge User', email: `${VIEWER_LOGIN}@example.invalid`, date: '2025-01-01T00:00:00Z' } },
        author: userJson(VIEWER_LOGIN), parents: parseCommit(r.objects.get(c.sha)?.data ?? Buffer.alloc(0)).parents.map((p) => ({ sha: p })),
        url: '',
      }));
      const { page, link } = paginate(req, apiPath, list, q);
      sendJson(res, 200, page, link ? { link } : {});
      return true;
    }
    // git/refs
    if (restSeg[0] === 'git' && restSeg[1] === 'refs') {
      if (method === 'POST' && restSeg.length === 2) {
        const ref = typeof b.ref === 'string' ? b.ref : '';
        const sha = typeof b.sha === 'string' ? b.sha : '';
        if (!ref.startsWith('refs/') || !r.objects.has(sha)) { errJson(res, 422, 'Invalid ref or sha'); return true; }
        if (r.refs.has(ref)) { errJson(res, 422, 'Reference already exists'); return true; }
        r.refs.set(ref, sha);
        const type = r.objects.get(sha)?.type ?? 'commit';
        sendJson(res, 201, { ref, object: { sha, type } }); return true;
      }
      if (method === 'GET' && restSeg.length >= 3) {
        const refName = `refs/${restSeg.slice(2).join('/')}`;
        const oid = r.refs.get(refName);
        if (!oid) { errJson(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, { ref: refName, object: { sha: oid, type: r.objects.get(oid)?.type ?? 'commit' } }); return true;
      }
      if (method === 'GET' && restSeg.length === 2) {
        sendJson(res, 200, [...r.refs.entries()].map(([ref, oid]) => ({ ref, object: { sha: oid, type: r.objects.get(oid)?.type ?? 'commit' } }))); return true;
      }
    }
    // contents
    if (restSeg[0] === 'contents') {
      const filePath = restSeg.slice(1).join('/');
      const ref = q.get('ref') ?? undefined;
      if (method === 'GET') {
        if (filePath === '') {
          const entries = dirAt(r, ref, '');
          if (!entries) { errJson(res, 404, 'Not Found'); return true; }
          sendJson(res, 200, entries.map((e) => ({ type: e.type, name: e.name, path: e.path, sha: e.sha, size: 0, url: '' }))); return true;
        }
        const f = fileAt(r, ref, filePath);
        if (f) {
          sendJson(res, 200, { type: 'file', encoding: 'base64', name: filePath.split('/').pop(), path: filePath, sha: f.oid, size: f.data.length, content: f.data.toString('base64'), url: '' });
          return true;
        }
        const entries = dirAt(r, ref, filePath);
        if (entries) { sendJson(res, 200, entries.map((e) => ({ type: e.type, name: e.name, path: e.path, sha: e.sha, size: 0, url: '' }))); return true; }
        errJson(res, 404, 'Not Found'); return true;
      }
      if (method === 'PUT') {
        const contentB64 = typeof b.content === 'string' ? b.content : '';
        const message = typeof b.message === 'string' ? b.message : 'update';
        const branch = typeof b.branch === 'string' ? b.branch : undefined;
        const content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
        const existing = fileAt(r, branch, filePath);
        if (existing && typeof b.sha === 'string' && b.sha !== existing.oid) { errJson(res, 409, 'sha does not match'); return true; }
        const result = commitFile(r, branch, filePath, content, message);
        sendJson(res, result.created ? 201 : 200, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: result.blobSha, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
          commit: { sha: result.commitSha, message, author: userJson(VIEWER_LOGIN) },
        });
        return true;
      }
      if (method === 'DELETE') {
        const existing = fileAt(r, undefined, filePath);
        if (!existing) { errJson(res, 404, 'Not Found'); return true; }
        const message = typeof b.message === 'string' ? b.message : 'delete';
        const result = commitFile(r, undefined, filePath, Buffer.alloc(0), message, true);
        sendJson(res, 200, { commit: { sha: result.commitSha, message, author: userJson(VIEWER_LOGIN) } });
        return true;
      }
    }
    // labels
    if (restSeg[0] === 'labels') {
      if (method === 'GET') { sendJson(res, 200, [...r.labels.values()].map(labelJson)); return true; }
      if (method === 'POST') {
        const nm = typeof b.name === 'string' ? b.name : '';
        const color = typeof b.color === 'string' ? b.color : 'ededed';
        if (nm === '') { errJson(res, 422, 'name is required'); return true; }
        const existing = r.labels.get(nm);
        if (existing) { sendJson(res, 201, labelJson(existing)); return true; }
        const label = { name: nm, color, description: typeof b.description === 'string' ? b.description : null };
        r.labels.set(nm, label);
        sendJson(res, 201, labelJson(label)); return true;
      }
    }
    // issues
    if (restSeg[0] === 'issues') {
      if (restSeg.length === 1) {
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          const bodyText = typeof b.body === 'string' ? b.body : '';
          const labelNames: string[] = Array.isArray(b.labels) ? b.labels.filter((x): x is string => typeof x === 'string') : [];
          const labels: { name: string; color: string; description: string | null }[] = [];
          for (const ln of labelNames) {
            const lab = r.labels.get(ln);
            if (!lab) { errJson(res, 422, `Label does not exist: ${ln}`); return true; }
            labels.push(lab);
          }
          const issue = createIssueInRepo(r, title, bodyText, labels);
          sendJson(res, 201, issueJson(r, issue)); return true;
        }
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          const sort = q.get('sort') ?? 'created';
          const dir = q.get('direction') ?? 'desc';
          let list = [...r.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          list.sort((a, b2) => sort === 'created' ? (dir === 'asc' ? a.createdSeq - b2.createdSeq : b2.createdSeq - a.createdSeq) : 0);
          const { page, link } = paginate(req, apiPath, list, q);
          sendJson(res, 200, page.map((i) => issueJson(r, i)), link ? { link } : {});
          return true;
        }
      }
      const num = parseInt(restSeg[1] ?? '', 10);
      const issue = Number.isInteger(num) ? r.issues.get(num) : undefined;
      if (restSeg.length === 2) {
        if (!issue) { errJson(res, 404, 'Not Found'); return true; }
        if (method === 'GET') { sendJson(res, 200, issueJson(r, issue)); return true; }
        if (method === 'PATCH') {
          if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) {
            issue.state = b.state;
            issue.closed_at = b.state === 'closed' ? isoOf(nextTs()) : null;
          }
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          issue.updatedSeq = nextTs(); issue.updated_at = isoOf(issue.updatedSeq);
          sendJson(res, 200, issueJson(r, issue)); return true;
        }
      }
      if (restSeg.length === 3 && restSeg[2] === 'comments') {
        if (!issue) { errJson(res, 404, 'Not Found'); return true; }
        if (method === 'POST') {
          const bodyText = typeof b.body === 'string' ? b.body : '';
          const seq = nextTs();
          const comment = { id: r.nextCommentId, body: bodyText, user: { login: VIEWER_LOGIN }, created_at: isoOf(seq), updated_at: isoOf(seq) };
          r.nextCommentId += 1;
          issue.comments.push(comment);
          sendJson(res, 201, { id: comment.id, body: comment.body, user: userJson(VIEWER_LOGIN), created_at: comment.created_at, updated_at: comment.updated_at });
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: userJson(VIEWER_LOGIN), created_at: c.created_at, updated_at: c.updated_at })));
          return true;
        }
      }
    }
    // pulls
    if (restSeg[0] === 'pulls') {
      if (restSeg.length === 1) {
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          const bodyText = typeof b.body === 'string' ? b.body : '';
          const head = typeof b.head === 'string' ? b.head : '';
          const base = typeof b.base === 'string' ? b.base : r.defaultBranch;
          const created = createPullInRepo(r, title, bodyText, head, base);
          if ('error' in created) { errJson(res, 422, created.error); return true; }
          sendJson(res, 201, pullJson(r, created)); return true;
        }
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          let list = [...r.pulls.values()];
          if (state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          list.sort((a, b2) => b2.createdSeq - a.createdSeq);
          const { page, link } = paginate(req, apiPath, list, q);
          sendJson(res, 200, page.map((p) => pullJson(r, p)), link ? { link } : {});
          return true;
        }
      }
      const num = parseInt(restSeg[1] ?? '', 10);
      const pull = Number.isInteger(num) ? r.pulls.get(num) : undefined;
      if (restSeg.length === 2) {
        if (!pull) { errJson(res, 404, 'Not Found'); return true; }
        if (method === 'GET') { sendJson(res, 200, pullJson(r, pull)); return true; }
      }
      if (restSeg.length === 3 && restSeg[2] === 'files') {
        if (!pull) { errJson(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, pull.files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, patch: '' })));
        return true;
      }
      if (restSeg.length === 3 && restSeg[2] === 'merge') {
        if (!pull) { errJson(res, 404, 'Not Found'); return true; }
        if (method === 'PUT') {
          const merged = mergePull(r, pull);
          if (!merged.ok) {
            if (merged.reason === 'conflict') { errJson(res, 405, 'Merge conflict'); return true; }
            errJson(res, 405, merged.reason ?? 'cannot merge'); return true;
          }
          sendJson(res, 200, { merged: true, sha: merged.sha, message: 'Pull request successfully merged.' });
          return true;
        }
      }
      void prMergeable; void gid;
    }
    errJson(res, 404, 'Not Found'); return true;
  }
  errJson(res, 404, 'Not Found'); return true;
}
