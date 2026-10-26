import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** PGlite's NodeFS does not prevent two processes from opening the same files. */
export async function lockDataDirectory(
  dataDir: string,
): Promise<() => Promise<void>> {
  const canonical = realpathSync(dataDir);
  const identity =
    process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const key = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  // Windows named pipes and Linux abstract sockets disappear when their owner exits.
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\ccse-pglite-${key}`
      : process.platform === "linux"
        ? `\0ccse-pglite-${key}`
        : join(tmpdir(), `ccse-pglite-${key}.sock`);
  const lock = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const onError = (cause: NodeJS.ErrnoException) => {
      reject(
        new Error(
          cause.code === "EADDRINUSE"
            ? `Database is already open in another process: ${canonical}. Stop the other Enterprise API before starting again.`
            : `Cannot lock database directory: ${canonical}`,
          { cause },
        ),
      );
    };
    lock.once("error", onError);
    lock.listen(address, () => {
      lock.removeListener("error", onError);
      resolve();
    });
  });
  lock.unref();
  return () =>
    new Promise<void>((resolve, reject) => {
      lock.close((error) => (error ? reject(error) : resolve()));
    });
}
