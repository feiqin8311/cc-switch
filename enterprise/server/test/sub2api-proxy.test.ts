import { createServer, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import {
  clearSub2ApiTokenCache,
  closeSub2ApiConnections,
  listUpstreamAccounts,
  type Sub2ApiConfig,
} from "../src/sub2api.ts";

const baseEnv = {
  NODE_ENV: "test",
  JWT_SECRET: "test-secret-test-secret-test-secret-123",
  SECRETS_KEY: Buffer.alloc(32, 7).toString("base64"),
  SUB2API_URL: "https://sub2api.invalid",
  SUB2API_EMAIL: "test@example.com",
  SUB2API_PASSWORD: "test-only",
};

describe("Sub2API proxy configuration", () => {
  it("accepts authenticated HTTP proxies and leaves blank configuration direct", () => {
    expect(
      loadConfig({ ...baseEnv, SUB2API_PROXY_URL: "  " }).sub2api,
    ).not.toHaveProperty("proxyUrl");
    expect(
      loadConfig({
        ...baseEnv,
        SUB2API_PROXY_URL: " http://user:encoded%40password@proxy.test:17890 ",
      }).sub2api?.proxyUrl,
    ).toBe("http://user:encoded%40password@proxy.test:17890");
  });

  it("rejects unsupported proxy addresses without including credentials in the error", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        SUB2API_PROXY_URL: "socks5://private:secret@proxy.test:17891",
      }),
    ).toThrow("SUB2API_PROXY_URL: must be an HTTP(S) proxy URL");
  });
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("Sub2API proxy transport", () => {
  afterEach(() => clearSub2ApiTokenCache());

  it("tunnels login, account lists and usage through the authenticated proxy", async () => {
    clearSub2ApiTokenCache();
    const paths: string[] = [];
    const proxyHeaders: unknown[] = [];
    const upstream = createServer((req, res) => {
      paths.push(req.url ?? "");
      proxyHeaders.push(req.headers["proxy-authorization"]);
      res.setHeader("content-type", "application/json");
      const data = req.url?.includes("/auth/login")
        ? { access_token: "test-token", expires_in: 3600 }
        : req.url?.includes("/usage/batch")
          ? { usage: { "1": { five_hour: { utilization: 25 } } } }
          : { total: 1, items: [{ id: 1, name: "proxied account" }] };
      req.resume();
      res.end(JSON.stringify({ data }));
    });
    const upstreamPort = await listen(upstream);
    const tunnels: string[] = [];
    const proxyAuth: unknown[] = [];
    const proxy = createServer();
    proxy.on("connect", (req, socket, head) => {
      tunnels.push(req.url ?? "");
      proxyAuth.push(req.headers["proxy-authorization"]);
      const remote = connect(upstreamPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) remote.write(head);
        remote.pipe(socket);
        socket.pipe(remote);
      });
      socket.on("error", () => remote.destroy());
      remote.on("error", () => socket.destroy());
      socket.on("close", () => remote.destroy());
    });
    const proxyPort = await listen(proxy);
    const cfg: Sub2ApiConfig = {
      url: "http://sub2api.invalid",
      email: "test@example.com",
      password: "test-only",
      proxyUrl: `http://proxy-user:secret%40value@127.0.0.1:${proxyPort}`,
    };
    try {
      const accounts = await listUpstreamAccounts(cfg);
      expect(accounts[0]?.name).toBe("proxied account");
      expect(accounts[0]?.windows[0]?.usedPercent).toBe(25);
      expect(paths).toEqual([
        "/api/v1/auth/login",
        "/api/v1/admin/accounts?page=1&page_size=100",
        "/api/v1/admin/accounts/usage/batch",
      ]);
      expect(tunnels.length).toBeGreaterThan(0);
      expect(tunnels.every((host) => host === "sub2api.invalid:80")).toBe(true);
      expect(
        proxyAuth.every(
          (value) =>
            value ===
            `Basic ${Buffer.from("proxy-user:secret@value").toString("base64")}`,
        ),
      ).toBe(true);
      expect(proxyHeaders).toEqual([undefined, undefined, undefined]);
    } finally {
      await closeSub2ApiConnections(cfg);
      await Promise.all(
        [upstream, proxy].map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
    }
  });
});
