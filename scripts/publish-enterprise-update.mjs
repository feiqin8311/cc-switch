#!/usr/bin/env node
// Copy a signed Tauri updater bundle into the enterprise server's updates dir
// and write latest.json with download URLs on that server.
//
// The other client only prompts when this version is newer than the one it is
// running, so bump `version` in src-tauri/tauri.conf.json before building.
//
//   export TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.cc-switch/enterprise-updater.key"
//   pnpm tauri build
//   node scripts/publish-enterprise-update.mjs --base http://127.0.0.1:4000

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const base = flag("--base", "http://127.0.0.1:4000").replace(/\/+$/, "");
const out = flag("--out", "enterprise/server/data/updates");
const notes = flag("--notes", "Enterprise update");
const bundleRoot = flag("--bundle", "src-tauri/target/release/bundle");

const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const version = conf.version;
if (!version) {
  console.error("src-tauri/tauri.conf.json has no version");
  process.exit(1);
}

function walk(dir, found = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, found);
    else if (entry.name.endsWith(".sig")) found.push(path);
  }
  return found;
}

function platformKey(name) {
  const mac = name.endsWith(".app.tar.gz.sig");
  const win = name.endsWith(".exe.sig") || name.endsWith(".msi.sig") || name.endsWith(".nsis.zip.sig");
  const linux = name.includes("AppImage") || name.endsWith(".deb.sig") || name.endsWith(".rpm.sig");
  const arm = /aarch64|arm64/i.test(name);
  const intel = /x86_64|x64|amd64/i.test(name);
  const hostArm = process.arch === "arm64";
  if (mac) {
    if (arm) return "darwin-aarch64";
    if (intel) return "darwin-x86_64";
    return hostArm ? "darwin-aarch64" : "darwin-x86_64";
  }
  if (win) return arm ? "windows-aarch64" : "windows-x86_64";
  if (linux) return arm ? "linux-aarch64" : "linux-x86_64";
  return null;
}

const sigs = walk(bundleRoot);
const platforms = {};
const copied = [];
mkdirSync(out, { recursive: true });

for (const sigPath of sigs) {
  const artifact = sigPath.slice(0, -".sig".length);
  const key = platformKey(sigPath);
  if (!key || !existsSync(artifact)) continue;
  const name = basename(artifact);
  copyFileSync(artifact, join(out, name));
  platforms[key] = {
    signature: readFileSync(sigPath, "utf8").trim(),
    url: `${base}/updates/files/${encodeURIComponent(name)}`,
  };
  copied.push(`${key} ${name}`);
}

if (copied.length === 0) {
  console.error(`No signed updater bundle under ${bundleRoot}.`);
  console.error("Build with TAURI_SIGNING_PRIVATE_KEY_PATH set, then run this again.");
  process.exit(1);
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync(join(out, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Published ${version} to ${out}`);
for (const line of copied) console.log(`  ${line}`);
console.log(`Clients on an older build will prompt after they next open the app.`);
console.log(`Manifest: ${base}/updates/latest.json`);
