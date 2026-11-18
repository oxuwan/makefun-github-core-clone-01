# github-core-clone-01 — GitHub-compatible git forge

[![make.fun](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/github-core-clone-01)
[![Node](https://img.shields.io/badge/node-22%2B-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A standalone GitHub-compatible git forge in a single Node 22 process, standard
library only — no git binary, no package manager, no outside service.

Built for the make.fun bounty
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01)
([referral link](https://make.fun/?ref=xk6tgtt0)).

## What it serves

- **Git smart HTTP** — upload-pack protocol v2 + receive-pack v0: clone, fetch
  (including shallow/deepen), push (create/update/delete refs, fast-forward
  enforcement), annotated tags. Own object store: blobs, trees, commits, tags,
  zlib packfiles (v2, OFS/REF deltas on read).
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  git refs, labels, issues, comments, pull requests, files, squash merges.
- **GraphQL v4** at `POST /api/graphql` — viewer, repository, node, issues
  with cursor pagination, and the create/close/merge/addComment mutations.
- **MCP** at `POST /mcp` — streamable HTTP, `server/discover` (2026-07-28)
  and legacy `initialize`, with tools `create_repo`, `get_repo`,
  `list_repos`, `create_issue`, `get_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`.

## Run locally

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

`main.ts` is the entrypoint: it binds an ephemeral port, registers it with
`$MAKEFUN_ENV_URL`, and polls `$MAKEFUN_ENV_URL/done` until the trial ends.
For a local smoke test without an env, run the app directly:

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types -e "
import('./app.ts').then(async ({ createApp }) => {
  const s = createApp();
  s.listen(8123, () => console.log('listening on 8123'));
});
"
```

Then, for example:

```sh
curl -H "Authorization: Bearer test-token" http://127.0.0.1:8123/api/v3/user
curl -H "Authorization: Bearer test-token" -X POST http://127.0.0.1:8123/api/v3/user/repos \
  -d '{"name":"demo"}'
git clone http://127.0.0.1:8123/<viewer>/demo.git
```

## Layout

- `main.ts` — entrypoint lifecycle (bind, register, poll done, exit 0).
- `app.ts` — HTTP router: `/healthz`, git, REST, GraphQL, MCP.
- `git.ts` — smart HTTP (info/refs v0/v2, ls-refs, upload-pack, receive-pack).
- `gitobj.ts` — git object model, pack codec, pkt-line framing.
- `store.ts` — in-memory store: repos, refs, objects, issues, pull requests.
- `common.ts` — auth, serializers, contents commits, PR merge.
- `rest.ts` — REST v3 routes.
- `graphql.ts` — GraphQL v4 mini executor.
- `mcp.ts` — MCP JSON-RPC tools.
- `scenario.ts` — deterministic scenario derivation (viewer login).

## Notes

- State is in-memory and deterministic: no wall-clock timestamps in exported
  state (all timestamps derive from a fixed epoch + sequence counters).
- Auth: every API/git call requires `Authorization: Bearer
  $MAKEFUN_SHOP_TOKEN`; missing or wrong token answers
  `401 {"message": "Requires authentication"}`.
- Never binds port 8080; the process binds an ephemeral port only.
