#!/usr/bin/env node
// Copy a signed Tauri updater bundle into the enterprise server's updates dir
// and write latest.json with download URLs on that server.
//
// The other client only prompts when this version is newer than the one it is
// running, so bump `version` in src-tauri/tauri.conf.json before building.
//
// Platforms are merged: publishing the macOS build and then the Windows build of
// the same version leaves both in latest.json. A different version replaces the
// manifest, so an old platform entry never claims to be the new version.
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
import { basename, extname, join } from "node:path";

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

// Windows clients are installed from the MSI (per-user WiX template); updating
// them with the NSIS installer would add a second install.
const isNsis = (name) => name.endsWith(".exe.sig") || name.endsWith(".nsis.zip.sig");

function artifactExt(name) {
  for (const ext of [".app.tar.gz", ".AppImage.tar.gz", ".nsis.zip", ".tar.gz", ".zip"]) {
    if (name.endsWith(ext)) return ext;
  }
  return extname(name);
}

const sigs = walk(bundleRoot).sort((a, b) => Number(isNsis(a)) - Number(isNsis(b)));
const manifestPath = join(out, "latest.json");
let previous = null;
try {
  previous = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch {
  // first publish
}
const platforms = previous?.version === version ? { ...previous.platforms } : {};
const fresh = new Set();
const copied = [];
mkdirSync(out, { recursive: true });

for (const sigPath of sigs) {
  const artifact = sigPath.slice(0, -".sig".length);
  const key = platformKey(sigPath);
  if (!key || !existsSync(artifact) || fresh.has(key)) continue;
  fresh.add(key);
  // The server only serves [A-Za-z0-9._-] names, and the bundle names carry the
  // product name with spaces. The version is in the name because files are served
  // as immutable. The signature covers the content, not the name.
  const ext = artifactExt(basename(artifact));
  const name = `ccswitch-enterprise-${version}-${key}${ext}`;
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
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Published ${version} to ${out}`);
for (const line of copied) console.log(`  ${line}`);
for (const key of Object.keys(platforms)) {
  if (!fresh.has(key)) console.log(`  ${key} kept from the earlier publish of ${version}`);
}
console.log(`Clients on an older build will prompt after they next open the app.`);
console.log(`Manifest: ${base}/updates/latest.json`);
