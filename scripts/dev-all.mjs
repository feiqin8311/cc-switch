import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const enterprise = resolve(root, "enterprise");
const isWindows = process.platform === "win32";
const pnpm = isWindows ? "pnpm.cmd" : "pnpm";
const children = new Set();
let shuttingDown = false;

function prefixOutput(child, label) {
  const pipe = (stream, method) => {
    if (!stream) return;
    const lines = createInterface({ input: stream });
    lines.on("line", (line) => console[method](`[${label}] ${line}`));
  };
  pipe(child.stdout, "log");
  pipe(child.stderr, "error");
}

function start(label, cwd, args) {
  const command = isWindows ? process.env.ComSpec ?? "cmd.exe" : pnpm;
  const commandArgs = isWindows ? ["/d", "/s", "/c", pnpm, ...args] : args;
  const child = spawn(command, commandArgs, {
    cwd,
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
    windowsHide: false,
  });
  children.add(child);
  prefixOutput(child, label);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown && code && code !== 0) {
      console.error(`[${label}] exited with code ${code}${signal ? ` (${signal})` : ""}`);
    }
  });
  child.once("error", (error) => {
    console.error(`[${label}] failed to start: ${error.message}`);
  });
  return child;
}

console.log("[dev] Starting CC Switch development stack...");
console.log("[dev] Enterprise API:       http://127.0.0.1:28473");
console.log("[dev] Admin console:         http://127.0.0.1:5174");
console.log("[dev] Main app renderer:     http://localhost:38471");

start("enterprise-api", enterprise, ["dev"]);
start("admin-console", enterprise, ["dev:admin"]);
const tauri = start("tauri", root, ["tauri", "dev"]);

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  if (tauri && !tauri.killed) tauri.kill();
  setTimeout(() => process.exit(code), 250);
}

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));
tauri.once("exit", (code) => shutdown(code ?? 0));
