// HTTP entry: routes /healthz, git smart HTTP, REST v3, GraphQL v4, MCP.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { errJson, pathOf, queryOf } from './common.ts';

export function createApp() {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const path = pathOf(req);
      if (path === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-github-request-id': `req-${process.hrtime.bigint().toString(36)}` });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (path === '/api/graphql' && req.method === 'POST') { await handleGraphQL(req, res); return; }
      if (path === '/mcp' && req.method === 'POST') { await handleMcp(req, res); return; }
      if (path.startsWith('/api/v3')) { await handleRest(req, res); return; }
      // Git smart HTTP: /{owner}/{repo}.git/info/refs | /git-upload-pack | /git-receive-pack
      const m = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
      if (m) { await handleGit(req, res, m[1] as string, m[2] as string, m[3] ?? '', queryOf(req)); return; }
      errJson(res, 404, 'Not Found');
    } catch (e) {
      try { errJson(res, 500, e instanceof Error ? e.message : 'Internal error'); } catch { /* socket gone */ }
    }
  });
}
