/**
 * Renames accounts whose (pinyin) username matches a name map, through the
 * admin API. Dry run by default; pass --apply to rename.
 *
 *   CCSE_URL=https://ccse.example.com CCSE_ADMIN_USERNAME=admin \
 *   CCSE_ADMIN_PASSWORD=... node src/tools/rename-users.ts names.json [--apply]
 *
 * names.json maps "family given" pinyin to the new username, e.g.
 * { "li meng": "李梦" }. A username matches when, lowercased and with
 * everything but a-z removed, it equals "limeng" or "mengli".
 */
import { readFileSync } from "node:fs";
import {
  API_PREFIX,
  ListUsersResponseSchema,
  SessionResponseSchema,
  type User,
  UserSchema,
} from "@ccse/contracts";

const [file, ...flags] = process.argv.slice(2);
const apply = flags.includes("--apply");
const base = process.env.CCSE_URL?.replace(/\/+$/, "");
const adminUsername = process.env.CCSE_ADMIN_USERNAME;
const adminPassword = process.env.CCSE_ADMIN_PASSWORD;
if (!file || !base || !adminUsername || !adminPassword) {
  console.error(
    "usage: CCSE_URL=… CCSE_ADMIN_USERNAME=… CCSE_ADMIN_PASSWORD=… node src/tools/rename-users.ts names.json [--apply]",
  );
  process.exit(2);
}

const names = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

/** Pinyin key ("limeng", "mengli") → new username. */
const byKey = new Map<string, string>();
for (const [pinyin, name] of Object.entries(names)) {
  const [family = "", ...given] = pinyin.trim().split(/\s+/);
  for (const key of [family + given.join(""), given.join("") + family]) {
    byKey.set(normalize(key), name);
  }
}

async function api(path: string, init: RequestInit = {}, token?: string) {
  const res = await fetch(`${base}${API_PREFIX}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  const body = res.status === 204 ? null : await res.json();
  if (!res.ok) {
    const message = (body as { error?: { message?: string } } | null)?.error
      ?.message;
    throw new Error(
      `${init.method ?? "GET"} ${path}: ${res.status} ${message ?? ""}`,
    );
  }
  return body;
}

const session = SessionResponseSchema.parse(
  await api("/auth/login", {
    method: "POST",
    body: JSON.stringify({
      username: adminUsername,
      password: adminPassword,
      deviceName: "rename-users script",
    }),
  }),
);

try {
  const { items } = ListUsersResponseSchema.parse(
    await api("/admin/users", {}, session.accessToken),
  );
  const taken = new Set(items.map((u) => u.username));
  const plan: { user: User; to: string }[] = [];
  const claimed = new Map<string, User>();
  for (const user of items) {
    const to = byKey.get(normalize(user.username));
    if (!to || to === user.username) continue;
    const other = claimed.get(to);
    if (other) {
      console.error(
        `! ${user.username} and ${other.username} both match ${to}; skipping ${user.username}`,
      );
      continue;
    }
    if (taken.has(to)) {
      console.error(`! ${to} already exists; skipping ${user.username}`);
      continue;
    }
    claimed.set(to, user);
    plan.push({ user, to });
  }

  for (const { user, to } of plan) console.log(`${user.username} → ${to}`);
  const unmatched = Object.values(names).filter(
    (n) => !claimed.has(n) && !taken.has(n),
  );
  if (unmatched.length > 0)
    console.log(`no account found for: ${unmatched.join("、")}`);
  const left = items.filter(
    (u) =>
      !plan.some((p) => p.user.id === u.id) &&
      !Object.values(names).includes(u.username),
  );
  if (left.length > 0)
    console.log(`left as is: ${left.map((u) => u.username).join(", ")}`);

  if (!apply) {
    console.log(`\ndry run: ${plan.length} to rename; re-run with --apply`);
  } else {
    for (const { user, to } of plan) {
      const updated = UserSchema.parse(
        await api(
          `/admin/users/${user.id}`,
          { method: "PATCH", body: JSON.stringify({ username: to }) },
          session.accessToken,
        ),
      );
      console.log(`renamed ${user.username} → ${updated.username}`);
    }
  }
} finally {
  await api("/auth/logout", {
    method: "POST",
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  }).catch(() => undefined);
}
