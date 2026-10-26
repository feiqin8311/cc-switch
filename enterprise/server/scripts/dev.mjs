import { fork } from "node:child_process";
import { watch } from "node:fs";
import { resolve } from "node:path";

const serverDir = resolve(import.meta.dirname, "..");
let child;
let stopping = false;
let timer;
let restarting = Promise.resolve();

function startServer() {
  child = fork(resolve(serverDir, "src/index.ts"), [], {
    cwd: serverDir,
    execArgv: [],
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    windowsHide: true,
  });
  const current = child;
  current.once("exit", (code) => {
    if (child === current) child = undefined;
    if (code && !stopping) {
      console.error(
        `API exited with code ${code}. Fix the error above; source changes will restart it.`,
      );
    }
  });
}

async function stopServer() {
  const current = child;
  if (!current || current.exitCode !== null || current.signalCode !== null)
    return;
  await new Promise((resolveExit) => {
    const timeout = setTimeout(() => {
      console.error(
        "API did not finish shutdown within 15 seconds; terminating it.",
      );
      current.kill();
    }, 15_000);
    current.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
    if (current.connected) current.send("shutdown", () => {});
    else current.kill();
  });
}

const watchers = [
  resolve(serverDir, "src"),
  resolve(serverDir, "../contracts/src"),
].map((directory) =>
  watch(directory, { recursive: true }, (_event, name) => {
    if (stopping || !name || !/\.(ts|json)$/.test(name.toString())) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      restarting = restarting.then(async () => {
        console.log(
          "Source changed; closing the database before restarting API...",
        );
        await stopServer();
        if (!stopping) startServer();
      });
    }, 200);
  }),
);

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  for (const watcher of watchers) watcher.close();
  await restarting;
  await stopServer();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.once("disconnect", () => void shutdown());
process.on("message", (message) => {
  if (message === "shutdown") void shutdown();
});
startServer();
