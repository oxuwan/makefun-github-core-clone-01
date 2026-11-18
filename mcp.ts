// MCP (Model Context Protocol) over streamable HTTP at POST /mcp.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRepo, getRepo, listViewerRepos } from './store.ts';
import { VIEWER_LOGIN } from './scenario.ts';
import { authOk, createIssueInRepo, createPullInRepo, errJson, isObj, issueJson, mergePull, parseJsonBody, pullJson, readBody, repoJson, sendJson } from './common.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef { name: string; description: string; inputSchema: { type: string; properties: Record<string, unknown>; required: string[] }; }
const TOOLS: ToolDef[] = [
  { name: 'create_repo', description: 'Create a new repository owned by the viewer.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'list_repos', description: 'List repositories owned by the viewer.', inputSchema: { type: 'object', properties: { owner: { type: 'string' } }, required: [] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'get_issue', description: 'Get one issue by number.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'integer' } }, required: ['owner', 'repo', 'issue_number'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request by number.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] } },
];
// Pre-serialized tools/list result so two calls are byte-identical.
const TOOLS_LIST_RESULT = JSON.stringify({ tools: TOOLS });

function pick(args: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (args[k] !== undefined && args[k] !== null && args[k] !== '') return args[k];
  return undefined;
}
function textResult(data: unknown): { content: { type: string; text: string }[]; structuredContent: unknown } {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data };
}
function errResult(message: string): { content: { type: string; text: string }[]; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}
function needRepo(args: Record<string, unknown>): { owner: string; name: string; repo: ReturnType<typeof getRepo> } | { error: string } {
  const owner = String(pick(args, ['owner', 'owner_login', 'org', 'login']) ?? '');
  const name = String(pick(args, ['repo', 'repository', 'repo_name']) ?? '');
  if (owner === '' || name === '') return { error: 'owner and repo are required' };
  if (owner !== VIEWER_LOGIN) return { error: `repository not found: ${owner}/${name}` };
  const repo = getRepo(owner, name);
  if (!repo) return { error: `repository not found: ${owner}/${name}` };
  return { owner, name, repo };
}

function callTool(name: string, args: Record<string, unknown>): { content: { type: string; text: string }[]; structuredContent?: unknown; isError?: boolean } {
  const norm = name.trim().toLowerCase();
  if (norm === 'create_repo') {
    const repoName = String(pick(args, ['name', 'repo', 'repository']) ?? '');
    if (repoName === '') return errResult('Missing required argument: name');
    if (getRepo(VIEWER_LOGIN, repoName)) return errResult(`Repository already exists: ${repoName}`);
    const r = createRepo(VIEWER_LOGIN, repoName, pick(args, ['private']) === true, typeof pick(args, ['description']) === 'string' ? String(pick(args, ['description'])) : '');
    return textResult(repoJson(r));
  }
  if (norm === 'list_repos') {
    return textResult(listViewerRepos(VIEWER_LOGIN).map(repoJson));
  }
  if (norm === 'get_repo') {
    const found = needRepo(args);
    if ('error' in found) return errResult(found.error);
    return textResult(repoJson(found.repo));
  }
  if (norm === 'create_issue') {
    const found = needRepo(args);
    if ('error' in found) return errResult(found.error);
    const title = String(pick(args, ['title', 'name']) ?? '');
    if (title === '') return errResult('Missing required argument: title');
    const body = String(pick(args, ['body', 'description', 'content']) ?? '');
    const issue = createIssueInRepo(found.repo, title, body, []);
    return textResult(issueJson(found.repo, issue));
  }
  if (norm === 'get_issue') {
    const found = needRepo(args);
    if ('error' in found) return errResult(found.error);
    const num = Number(pick(args, ['issue_number', 'number', 'issueNumber']) ?? NaN);
    const issue = found.repo.issues.get(num);
    if (!issue) return errResult(`issue not found: ${num}`);
    return textResult(issueJson(found.repo, issue));
  }
  if (norm === 'list_issues') {
    const found = needRepo(args);
    if ('error' in found) return errResult(found.error);
    const state = String(pick(args, ['state']) ?? 'open');
    let list = [...found.repo.issues.values()];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => b.createdSeq - a.createdSeq);
    return textResult(list.map((i) => issueJson(found.repo, i)));
  }
  if (norm === 'create_pull_request') {
    const found = needRepo(args);
    if ('error' in found) return errResult(found.error);
    const title = String(pick(args, ['title']) ?? '');
    const head = String(pick(args, ['head', 'head_ref', 'head_branch']) ?? '');
    const base = String(pick(args, ['base', 'base_ref', 'base_branch']) ?? '');
    if (title === '' || head === '' || base === '') return errResult('Missing required argument: title, head and base are required');
    const body = String(pick(args, ['body', 'description', 'content']) ?? '');
    const created = createPullInRepo(found.repo, title, body, head, base);
    if ('error' in created) return errResult(created.error);
    return textResult(pullJson(found.repo, created));
  }
  if (norm === 'merge_pull_request') {
    const found = needRepo(args);
    if ('error' in found) return errResult(found.error);
    const num = Number(pick(args, ['pull_number', 'number', 'pullNumber']) ?? NaN);
    const pull = found.repo.pulls.get(num);
    if (!pull) return errResult(`pull request not found: ${num}`);
    const merged = mergePull(found.repo, pull);
    if (!merged.ok) return errResult(merged.reason ?? 'cannot merge');
    return textResult({ merged: true, sha: merged.sha, message: 'Pull request successfully merged.', number: num });
  }
  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const msg = parsed.value;
  if (!isObj(msg) || typeof msg.method !== 'string') {
    sendJson(res, 400, { jsonrpc: '2.0', id: isObj(msg) && 'id' in msg ? (msg as Record<string, unknown>).id ?? null : null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const id = 'id' in msg ? (msg.id as string | number | null) : undefined;
  const isNotification = id === undefined || id === null;
  const method = msg.method as string;
  if (method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return true;
  }
  if (!authOk(req)) { errJson(res, 401, 'Requires authentication'); return true; }
  const params = isObj(msg.params) ? (msg.params as Record<string, unknown>) : {};
  const respond = (result: unknown): void => sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
  const respondError = (code: number, message: string): void => sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  if (method === 'server/discover') {
    respond({ supportedVersions: SUPPORTED_VERSIONS, protocolVersion: '2026-07-28', serverInfo: SERVER_INFO, capabilities: { tools: {} } });
    return true;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
    respond({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    return true;
  }
  if (method === 'ping') { respond({}); return true; }
  if (method === 'tools/list') {
    // Byte-identical across calls: send the pre-serialized payload.
    const body = `{"jsonrpc":"2.0","id":${JSON.stringify(id ?? null)},"result":${TOOLS_LIST_RESULT}}`;
    res.writeHead(200, { 'content-type': 'application/json', 'x-github-request-id': `req-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}` });
    res.end(body);
    return true;
  }
  if (method === 'tools/call') {
    const toolName = String(params.name ?? '');
    const args = isObj(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const known = TOOLS.some((t) => t.name === toolName);
    if (!known) { respondError(-32602, `Unknown tool: ${toolName}`); return true; }
    respond(callTool(toolName, args));
    return true;
  }
  void isNotification;
  respondError(-32601, `Method not found: ${method}`);
  return true;
}
