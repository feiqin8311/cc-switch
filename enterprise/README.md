# CC Switch Enterprise

Server and admin console for the enterprise (Codex-only) edition of CC Switch.

| Package | Purpose |
|---|---|
| `contracts/` | API contract (zod schemas + types) shared by server, admin console and desktop client |
| `server/` | Enterprise center: users & roles, client config, model gateway, conversation retention, skill/plugin marketplace |
| `admin/` | Admin web console (React + Vite), served by the server at `/` in production |

## Run locally

Requires Node ≥ 22.18 (TypeScript runs natively, no build step) and pnpm.

```bash
cd enterprise
pnpm install
pnpm dev            # http://127.0.0.1:4000, embedded PGlite in server/data/
```

On first start an `admin` user is created. Its generated password is written to
`server/data/initial-admin-password.txt` (or set `ADMIN_PASSWORD` beforehand).

```bash
pnpm test           # server tests (in-memory PGlite)
pnpm typecheck
pnpm lint
```

## Admin console

Web console for users, gateway providers, usage, conversation audit, the
retention policy and the skill/plugin marketplace. Pages appear per permission.

```bash
pnpm dev            # server on http://127.0.0.1:4000
pnpm dev:admin      # console on http://127.0.0.1:5174 (proxies /api to :4000)
pnpm --filter @ccse/admin build   # → admin/dist (absolute "/" asset paths)
```

The server has no CORS, so in development the browser talks only to the Vite
origin. In production serve `admin/dist` at `/` with an `index.html` fallback
for client-side routes. The access token stays in memory and the refresh token
in `sessionStorage` (per tab).

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` requires `DATABASE_URL`, `JWT_SECRET` and `SECRETS_KEY` |
| `HOST` / `PORT` | `127.0.0.1` / `4000` | |
| `DATABASE_URL` | – | `postgres://…`; unset → embedded PGlite under `DATA_DIR/pglite` |
| `DATA_DIR` | `./data` | dev secrets, PGlite files, initial admin password |
| `JWT_SECRET` | generated in dev | ≥ 32 chars |
| `SECRETS_KEY` | generated in dev | base64 of 32 bytes; encrypts upstream API keys (AES-256-GCM). Back it up — losing it makes stored keys unreadable |
| `ADMIN_DIST_DIR` | `../admin/dist` | admin console build served at `/` (skipped when missing) |
| `TRUST_PROXY` | `false` | `true` behind a reverse proxy (client IP for rate limiting) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / generated | only used when the users table is empty |

Migrations live in `server/drizzle/` and are applied on startup. After changing
`server/src/db/schema.ts` run `pnpm --filter @ccse/server db:generate`.

## Auth model

- Roles: `admin`, `member`, `viewer`; permissions per role are defined in
  `contracts/src/index.ts` (`ROLE_PERMISSIONS`) and enforced only on the server.
- Access token: HS256 JWT, 15 min. The user and session are re-checked on every
  request, so disabling a user or revoking a session is immediate.
- Refresh token: opaque, single-use, rotated on every refresh, 30-day sliding
  session. Replaying a used token revokes the whole session.
- Login: argon2id, 5 failures / 15 min per account+IP, 30 per IP.

## Features

| Area | Server | Desktop client (`src-tauri/src/enterprise/`) |
|---|---|---|
| Roles | users, roles, permissions, sessions | login in the Rust backend; tokens never reach the webview; session file 0600 |
| Models | gateway providers (keys encrypted), per-role access, per-user daily token limit, usage stats; `POST /gateway/<id>/v1/responses` streams to the upstream | one gateway key per login; each provider becomes a read-only `ccse-<id>` Codex card; model switcher on Codex cards. Personal ChatGPT login keeps working unchanged |
| Retention | policy + notice, idempotent uploads, audit search, purge after `retentionDays` | uploads Codex rollouts only for sessions started **after** the employee acknowledged the notice; rollouts are the offline buffer |
| Marketplace | admin uploads skill / Codex plugin zips (validated), mandatory flag, sha256 | one-click install / update / uninstall; skills go to `~/.codex/skills`, plugins via a local `ccswitch-enterprise` Codex marketplace + `codex plugin add`; mandatory items auto-install |

The desktop edition is locked to Codex by `CODEX_ONLY` in `src/config/edition.ts`
and `src-tauri/src/settings.rs` (other apps' code is kept for upstream merges).

## Desktop updates

A logged-in client checks `{server}/updates/latest.json` on launch. A newer
signed build opens a dialog; confirming downloads it, verifies the minisign
signature, installs, and restarts. The private key stays on the machine that
builds the app (`~/.cc-switch/enterprise-updater.key`). The public key is in
`src-tauri/tauri.conf.json`.

```bash
# bump version in src-tauri/tauri.conf.json and package.json first
export TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.cc-switch/enterprise-updater.key"
pnpm tauri build
node scripts/publish-enterprise-update.mjs --base http://127.0.0.1:4000
```

That writes `enterprise/server/data/updates/`. Restart the server if it was
already running, then open the other client. `pnpm tauri dev` can show the
dialog but cannot install into itself; the other machine needs a packaged build
that already contains this updater. The first install of that build is manual.

## Deploy (Docker)

```bash
cd enterprise
cp .env.example .env      # fill in POSTGRES_PASSWORD, JWT_SECRET, SECRETS_KEY, ADMIN_PASSWORD
docker compose up -d --build
```

This runs Postgres 17 and the server (admin console included) on
`127.0.0.1:4000`. Put a TLS reverse proxy (nginx / caddy) in front and set
`TRUST_PROXY=true`: the desktop client only accepts `https://` server URLs
(plain `http://` is allowed for localhost only). Proxy timeouts must allow long
streaming responses on `/gateway/` (e.g. `proxy_read_timeout 600s;
proxy_buffering off;` in nginx) and request bodies up to 32 MB.

Back up the Postgres volume and `SECRETS_KEY`.
