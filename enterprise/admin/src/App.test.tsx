import {
  type Permission,
  permissionsForRole,
  type SessionResponse,
} from "@ccse/contracts";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { ApiClient } from "./lib/api";
import { memoryTokenStore } from "./lib/tokenStore";
import { AppProviders } from "./providers";

const admin = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "admin",
  displayName: "管理员甲",
  role: "admin" as const,
  disabled: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: "2026-10-01T08:00:00.000Z",
};

const FIXTURES: Record<string, unknown> = {
  "/admin/users": { items: [admin] },
  "/admin/providers": {
    items: [
      {
        id: "openai-main",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        wireApi: "responses",
        apiKeyHint: "sk-…a1b2",
        models: [{ id: "gpt-5", displayName: "GPT-5" }],
        defaultModel: "gpt-5",
        allowedRoles: ["admin", "member"],
        dailyTokenLimitPerUser: null,
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  },
  "/admin/usage": {
    items: [
      {
        date: "2026-10-12",
        userId: admin.id,
        username: "admin",
        providerId: "openai-main",
        model: "gpt-5",
        requests: 3,
        inputTokens: 1200,
        outputTokens: 300,
      },
    ],
  },
  "/admin/retention-policy": {
    enabled: true,
    noticeText: "对话将被留存用于审计",
    retentionDays: 180,
  },
  "/admin/conversations": {
    items: [
      {
        id: "c1",
        user: { id: admin.id, username: "admin", displayName: "管理员甲" },
        clientSessionId: "s1",
        deviceName: "MacBook",
        title: "修复登录问题",
        projectDir: "/work/app",
        model: "gpt-5",
        startedAt: "2026-10-12T01:00:00.000Z",
        lastMessageAt: "2026-10-12T02:00:00.000Z",
        messageCount: 4,
      },
    ],
    nextCursor: null,
  },
  "/market/items": {
    items: [
      {
        id: "code-review",
        kind: "skill",
        name: "代码评审",
        description: "",
        version: "1.0.0",
        mandatory: false,
        sha256: "00",
        sizeBytes: 2048,
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    ],
  },
};

function sessionFor(permissions: Permission[]): SessionResponse {
  return {
    accessToken: "a",
    accessTokenExpiresAt: "2026-01-01T00:15:00.000Z",
    refreshToken: "r1",
    refreshTokenExpiresAt: "2026-02-01T00:00:00.000Z",
    user: admin,
    permissions,
  };
}

function renderAt(path: string, permissions: Permission[]) {
  const fetchMock = async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const route = url.pathname.replace(/^\/api\/v1/, "");
    if (route === "/auth/refresh") {
      return Response.json(sessionFor(permissions));
    }
    const body = FIXTURES[route];
    return body
      ? Response.json(body)
      : Response.json(
          { error: { code: "not_found", message: "nope" } },
          { status: 404 },
        );
  };
  const client = new ApiClient({
    fetch: fetchMock as typeof fetch,
    tokenStore: memoryTokenStore("r0"),
  });
  render(
    <AppProviders client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </AppProviders>,
  );
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error");
});
afterEach(() => {
  expect(consoleError).not.toHaveBeenCalled();
  consoleError.mockRestore();
});

describe("App", () => {
  it.each([
    ["/users", "用户管理", "管理员甲"],
    ["/providers", "模型与网关", "openai-main"],
    ["/usage", "用量统计", "按用户汇总"],
    ["/conversations", "对话审计", "修复登录问题"],
    ["/retention", "留存策略", "对话将被留存用于审计"],
    ["/market", "技能与插件市场", "代码评审"],
  ])("renders %s for an admin", async (path, title, content) => {
    renderAt(path, permissionsForRole("admin"));
    expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
    expect((await screen.findAllByText(content)).length).toBeGreaterThan(0);
  });

  it("shows 无管理权限 to members", async () => {
    renderAt("/", permissionsForRole("member"));
    expect(await screen.findByText("无管理权限")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "用户管理" })).toBeNull();
  });

  it("makes the retention policy read-only without settings.manage", async () => {
    renderAt("/retention", ["audit.read"]);
    expect(await screen.findByText(/只读/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  });
});
