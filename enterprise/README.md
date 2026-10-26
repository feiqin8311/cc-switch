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

The local development login defaults to `admin` / `123456`. Production must set
an explicit `ADMIN_PASSWORD` in the environment.

```bash
pnpm test           # server tests (in-memory PGlite)
pnpm typecheck
pnpm lint
```

For an offline account preview, set `DEMO_UPSTREAM_ACCOUNTS=true` in
`enterprise/.env` and restart the server. The upstream page and subscription
statistics use the same 12 screenshot-style accounts; Kevin is excluded from
costs and the Coding Plan fee can be filled manually. Demo monthly snapshots
are stored separately. Set the flag to `false` to return to live accounts.
The flag is ignored in production.

### 本机用量图表测试数据

先停止本机企业 API（PGlite 同一时间只能由一个进程打开），在 `enterprise/` 下运行：

```bash
pnpm --filter @ccse/server seed:usage
# 可选：指定天数、UTC 截止日期或 server/ 下的其他本机数据目录
pnpm --filter @ccse/server seed:usage --days 45 --to 2026-10-26 --data-dir data
```

然后重新启动 `pnpm dev` 和 `pnpm dev:admin`，打开用量统计，选择近 7 天、近 30 天或自定义日期测试。
默认向 `server/data/pglite` 追加最近 45 天的 6,480 条用量，包含 36 个 `demo_usage_` 测试用户、
8 个带“测试·”前缀的部门及 4 名未分组成员，涵盖 4 个测试供应商、12 个模型与供应商组合，
包括长名称、低用量、零输出、缓存、旧请求、未计价与部分计价场景。
相同日期重复执行不会重复插入。脚本只操作本机已有的 PGlite 数据库，不读取 `DATABASE_URL`，
不调用上游服务，也不创建可调用真实上游的模型服务；测试用户使用随机密码。

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
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / `123456` | development defaults; production must set `ADMIN_PASSWORD` |

Migrations live in `server/drizzle/` and are applied on startup. After changing
`server/src/db/schema.ts` run `pnpm --filter @ccse/server db:generate`.

### 火山方舟 Coding Plan 用量

管理员「上游账号」页在现有 Sub2API 账号列表末尾展示火山方舟 Coding Plan 卡片，沿用相同的两列卡片、状态和黑色用量进度条，显示 5 小时、周、订阅月使用率及重置时间、套餐档位与到期时间。页面顶部的「刷新」同时更新两个来源，未配置 Sub2API 时也可单独显示火山方舟账号。

在「用户管理 → 编辑 → 用量窗口」或批量「设置用量窗口」中勾选「火山方舟 Coding Plan」并保存后，该员工可以在桌面端「用量窗口」查看同一账号的 5 小时、7 天和月度额度。用量窗口的账号勾选也同步控制网页后台「上游账号」的数据范围：组长及其他非管理员只能看到勾选的账号，一个都不勾则两处均为空；网页入口仍需「上游账号」管理菜单权限。管理员始终可见全部账号；取消勾选后，员工后续刷新不再返回该账号数据，无需重新登录。桌面和网页每分钟自动刷新，也可手动刷新。火山方舟无需配置 Sub2API 即可单独使用。此次权限同步需部署更新企业服务端和管理后台，沿用现有账号分配，无需数据库迁移或更新桌面客户端。

分配沿用 `upstreamAccountIds`，保留 `-1`（`CODING_PLAN_ACCOUNT_ID`）代表火山方舟，正整数代表 Sub2API 账号，无需数据库迁移。`GET /api/v1/admin/upstream/accounts` 的 `codingPlanAvailable` 提供勾选项；`GET /api/v1/client/upstream/accounts` 仅向管理员和获分配的用户返回 `codingPlan`，权限由服务端校验，AK/SK 始终留在服务端。

在 `enterprise/.env` 中填写 `VOLCENGINE_ACCESS_KEY_ID` 和 `VOLCENGINE_SECRET_ACCESS_KEY`，然后重启企业服务端。服务端会自动读取此文件，操作系统/Docker 环境变量优先；`.env` 已被忽略，请勿提交密钥。可选设置 `VOLCENGINE_REGION`（默认 `cn-beijing`）及 `VOLCENGINE_PROVIDER_ID`（默认 `volcengine-coding`）。Docker Compose 也会传入这些变量。

服务端以火山引擎 V4 签名调用 `GetCodingPlanUsage`（`Version=2024-01-01`），并独立调用 `GetPersonalPlan`（`Plan=CodingPlan`）补充订阅信息。仅查询信息，不创建或续费套餐。推理 API Key 无法代替此处的账号 AK/SK；账号需具有相应的方舟查询权限。套餐详情读取失败时仍展示已获取的额度，不推测档位、总 token 额度或缺失的重置时间。

`GET /api/v1/admin/usage/coding-plan` 需要登录及 `audit.read` 或 `upstream.read` 权限，非管理员还须获分配 `CODING_PLAN_ACCOUNT_ID`，否则返回 403；只返回归一化的用量与订阅信息。成功结果缓存 30 秒，并发请求合并，网页每分钟刷新一次，每次请求均重新校验账号分配。查询失败时短暂缓存错误并保留上次成功数据，同时标记同步延迟。此处为火山账号共享额度；「用量统计」页只展示原有的网关用量统计。

## 用量费用估算

用量统计的「按用户汇总」「按模型汇总」「明细」末列显示「估算费用（USD）」。
网关从 Responses/Chat Completions 的流式和非流式响应采集输入、输出、缓存命中、缓存写入及上游模型。
输入总数包含缓存，先扣除缓存命中和写入，再将四类数量乘以对应的每百万 Token 单价。
汇总会先按上游计价模型计算，再合并回日期、用户、模型服务和请求模型；前端筛选、分页不改变金额口径。

单价快照来自桌面端 `src-tauri/src/database/schema.rs::seed_model_pricing`，位于
`server/src/gateway/model-pricing.json`；从仓库根目录运行
`node enterprise/scripts/sync-model-pricing.mjs` 可重新同步，不需要访问用户本机定价数据库。
它使用内置的标准参考价，未包含长上下文/时段阶梯、订阅费用分摊或供应商折扣，
不代表实际扣费。每次查询按当前快照估算，更新价格也会影响历史估算。

服务端启动时自动执行 `0012_usage_estimates` 迁移，保留原有用量。
历史记录按已保存的输入、输出、缓存命中及请求模型估算；未采集的缓存写入按 0 处理，
界面会提示可能偏低。未知模型返回空金额并显示「未计价」；
同一汇总中存在未计价请求时，仅累加有价部分并显示「部分」。
服务端与管理后台需要一起更新，无需更新桌面客户端。

## Auth model

管理员可在「用户管理 → 编辑 → 用量窗口下方的管理菜单权限」中，逐项勾选用户管理、设备管理、用量统计、上游账号、MCP、连接器、Skills、提示词和会话；新建用户时也可设置。保存后该用户的现有会话会被注销，重新登录后按新权限显示菜单，后端接口同步校验权限。管理员始终拥有全部菜单；未设置过的已有用户沿用原角色默认权限。

普通用户获授「用户管理」后仅能查看本组用户、修改本组成员/只读角色，不能分配菜单权限或提升为管理员。组长的用量统计仍仅限本组。会话菜单包含对话查看及留存策略管理。模型使用和桌面市场安装权限仍由角色决定，管理菜单配置不改变这两项能力。

部署需同时更新服务端和管理后台，服务端启动时自动应用 `0009_admin_menus` 数据库迁移。`adminMenus: null` 表示沿用角色默认菜单，`[]` 表示关闭全部管理菜单；两者均不会限制管理员。`GET /admin/user-options` 仅返回各管理页面选择用户所需的姓名、ID 与组，不授予用户管理能力。

- Roles: `admin`, `group_leader`, `leader`, `member`, `viewer`; permissions per role are defined in
  `contracts/src/index.ts` (`ROLE_PERMISSIONS`) and enforced only on the server.
- Group leaders can list users in their assigned group and change members between
  `member` and `viewer`. They cannot edit administrators, other leaders, account
  details or group assignments. Gateway and device usage are restricted to their
  current group; the console fixes the group field and allows member selection.
  Leaders without a group see no users or usage. Only administrators assign groups
  and grant the `group_leader` role.
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
`127.0.0.1:4000`. A TLS reverse proxy (nginx / caddy) is optional; the desktop
client accepts `http://` and `https://` server URLs. Set `TRUST_PROXY=true`
when behind a proxy. Proxy timeouts must allow long
streaming responses on `/gateway/` (e.g. `proxy_read_timeout 600s;
proxy_buffering off;` in nginx) and request bodies up to 32 MB.

Back up the Postgres volume and `SECRETS_KEY`.

### Subscription renewal accounting

Account costs now use a retained per-account renewal ledger, rather than replacing
monthly totals with the current live account list. Live Sub2API accounts are
paginated; subscription expiry comes from `credentials.subscription_expires_at`
or inherited `parent_subscription_expires_at`. For monthly subscriptions the
estimated payment month is the expiry month minus one (Asia/Shanghai).
Quota reset times and access-token expiry never determine payment dates.

Each observed account/expiry cycle is recorded once. Removing or disabling an
account, renaming it, or changing a quoted price does not subtract or move a
recorded charge. A new expiry cycle adds a new charge. Missing dates remain
pending until an administrator confirms the billing month; unknown prices can
be completed even after an account has disappeared. This is an inferred renewal
ledger, not an imported payment receipt or a reconstruction of unobserved cycles.
Legacy live-list monthly snapshots remain in settings for reconciliation and
are excluded from new ledger totals to avoid double counting. Demo ledger data
is isolated from live data.
