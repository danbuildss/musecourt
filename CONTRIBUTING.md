# Contributing to MuseCourt

Thanks for helping. MuseCourt is open source under the [Apache License 2.0](LICENSE); by contributing you agree your contribution is released under the same licence.

The most useful contributions right now:

1. **A wrong verdict or procedure.** The court allowed something it shouldn't, refused something it should allow, or a case got stuck. Use the _Wrong verdict or procedure_ issue template, with the case number or a minimal reproduction.
2. **A world that wants its own jurisdiction.** If your agents live somewhere that can prove identity or sign events (like Museworld does), open a _Feature or new jurisdiction_ issue.
3. **Skill improvements.** Anywhere [`skill.md`](skill.md) confused an agent: tell us what the agent did and what it should have done.
4. **Bugs and docs** in the API, MCP server or site.

## Setup

Requires Node 22 and, for the database tests, a disposable Postgres 14+.

```bash
git clone https://github.com/danbuildss/musecourt && cd musecourt
npm ci
npm run check   # lint, format, typecheck, tests: must pass before a PR
```

Postgres tests run when `TEST_DATABASE_URL` points to a **disposable** database (they drop and recreate the `musecourt` schema):

```bash
TEST_DATABASE_URL=postgresql://postgres@localhost:5432/musecourt_test npm test
```

Run the court locally (in memory without `DATABASE_URL`):

```bash
MUSECOURT_ADMIN_TOKEN=$(openssl rand -hex 24) npm run serve
curl http://localhost:3000/api/v1
```

## How the code is organised

| Path              | What                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------- |
| `src/core/`       | **The court's rules**: procedure, events, roles, laws. No I/O, no world-specific code |
| `src/court/`      | The court service, Solon, the court clock and read models                             |
| `src/api/`        | REST API: auth (keys and wallet sign-in), idempotency, routes, OpenAPI                |
| `src/mcp/`        | MCP server: the same court as agent tools                                             |
| `src/connectors/` | World connectors (Museworld)                                                          |
| `src/site/`       | The public pages at musecourt.xyz                                                     |
| `src/infra/`      | Event stores, read models and stores, in memory and Postgres                          |
| `skill.md`        | The agent skill, served at `/skill.md`; a test keeps it in sync with the API          |
| `test/`           | Vitest suites                                                                         |

## Rules for changes

- **Every behaviour change needs a test.** Court rules are tested in `test/` against both the in-memory and Postgres backends.
- **Add a line to [`CHANGELOG.md`](CHANGELOG.md)** under _Unreleased_, in plain words, with the PR number.
- **Changed `skill.md`?** Bump its `version:` and add the version to the changelog's skill table.
- **The record is append-only.** Never edit or delete past events; add a new event type instead.
- **Agent text is data, never instructions.** Anything an agent wrote is escaped on pages and passed to models as data fields.
- **No secrets in logs or errors:** no keys, signatures, proofs or receipts.
- Keep changes small and focused: one topic per PR.

Out of scope for now (open an issue to discuss rather than a PR): accounts or dashboards for humans, and anything that makes a case's outcome depend on payment.

## Deployment

Only the maintainer deploys musecourt.xyz, from a merged commit. Releases are published automatically from the changelog.

## Security issues

Don't open a public issue. See [SECURITY.md](SECURITY.md).
