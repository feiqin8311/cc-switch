import {
  type Permission,
  permissionsForRole,
  type SessionResponse,
} from "@ccse/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
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
  upstreamAccountIds: [] as number[],
  groupName: "",
  offboardedAt: null,
  offboardedBy: null,
};

const leaver = {
  ...admin,
  id: "22222222-2222-4222-8222-222222222222",
  username: "bob",
  displayName: "Bob",
  role: "member" as const,
};
const departed = {
  ...leaver,
  id: "33333333-3333-4333-8333-333333333333",
  username: "carol",
  displayName: "Carol",
  disabled: true,
  offboardedAt: "2026-10-10T08:00:00.000Z",
  offboardedBy: "admin",
};

const FIXTURES: Record<string, unknown> = {
  "/admin/users": { items: [admin, leaver, departed] },
  "/admin/fleet": {
    revision: 0,
    mode: "direct",
    activeProviderId: "",
    stackMemberIds: [],
    providers: [],
    updatedAt: null,
  },
  "/admin/devices": { items: [], serverTime: "2026-10-13T00:00:00.000Z" },
  "/admin/profiles": { items: [] },
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
  "/admin/usage/devices": { items: [] },
  "/admin/upstream/accounts": {
    configured: true,
    error: null,
    items: [
      {
        id: 39,
        name: "Feiqin-Gpt",
        email: "a@example.com",
        platform: "openai",
        type: "oauth",
        status: "active",
        schedulable: true,
        groups: ["openai-default"],
        windows: [
          {
            id: "5h",
            usedPercent: 0,
            remainingSeconds: 13800,
            resetsAt: "2026-10-14T20:00:00.000Z",
            requests: 2,
            tokens: 9800,
            accountCost: 0.01,
            userCost: 0.01,
          },
          {
            id: "7d",
            usedPercent: 3,
            remainingSeconds: 480000,
            resetsAt: "2026-10-23T02:53:00.000Z",
            requests: 20,
            tokens: 311900,
            accountCost: 0.44,
            userCost: 0.44,
          },
        ],
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
  "/admin/retention-policy": { enabled: true },
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
        publishedBy: null,
        publishedByName: null,
      },
      {
        id: "team-rules",
        kind: "prompt",
        name: "团队约定",
        description: "",
        version: "1.0.0",
        mandatory: true,
        sha256: "01",
        sizeBytes: 120,
        updatedAt: "2026-10-01T00:00:00.000Z",
        publishedBy: admin.id,
        publishedByName: "admin",
      },
      {
        id: "dws",
        kind: "connector",
        name: "钉钉 Workspace CLI",
        description:
          "官方 dws 命令行。员工安装后会把日历、文档、AI 表格等 Skill 接到 Codex。",
        version: "1.0.0",
        mandatory: false,
        sha256: "02",
        sizeBytes: 18,
        updatedAt: "2026-10-01T00:00:00.000Z",
        publishedBy: admin.id,
        publishedByName: "admin",
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
  const posts: string[] = [];
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const route = url.pathname.replace(/^\/api\/v1/, "");
    if (route === "/auth/refresh") {
      return Response.json(sessionFor(permissions));
    }
    if (init?.method === "POST") posts.push(route);
    if (route === `/admin/users/${leaver.id}/offboard`) {
      return Response.json({
        user: {
          ...leaver,
          disabled: true,
          offboardedAt: "2026-10-16T00:00:00.000Z",
          offboardedBy: "admin",
        },
        revokedSessions: 2,
        disabledDevices: 1,
      });
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
  return { posts };
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error");
});
afterEach(() => {
  expect(consoleError).not.toHaveBeenCalled();
  consoleError.mockRestore();
});

const tabNames = () => screen.queryAllByRole("tab").map((t) => t.textContent);

describe("App", () => {
  it.each([
    ["/users", "用户管理", "admin"],
    ["/devices", "设备管理", "还没有电脑上报"],
    ["/devices?tab=profiles", "设备管理", "还没有配置方案"],
    ["/devices?tab=providers", "设备管理", "openai-main"],
    ["/usage", "用量统计", "按用户汇总"],
    ["/upstream", "上游账号", "Feiqin-Gpt"],
    ["/skills", "Skills", "代码评审"],
    ["/mcp", "MCP", "还没有 MCP 服务器"],
    ["/connectors", "连接器", "钉钉 Workspace CLI"],
    ["/prompts", "提示词", "团队约定"],
    ["/conversations", "会话", "修复登录问题"],
    ["/conversations?tab=retention", "会话", "已开启：客户端每天同步一次对话"],
  ])("renders %s for an admin", async (path, title, content) => {
    renderAt(path, permissionsForRole("admin"));
    expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
    expect((await screen.findAllByText(content)).length).toBeGreaterThan(0);
  });

  it("offboards a user instead of deleting them", async () => {
    const { posts } = renderAt("/users", permissionsForRole("admin"));
    expect(await screen.findByText("bob")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    // Only bob gets the action: not yourself, not someone already offboarded.
    const buttons = screen.getAllByRole("button", { name: "离职" });
    expect(buttons).toHaveLength(1);
    expect(screen.getByText("已离职")).toBeTruthy();

    fireEvent.click(buttons[0] as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "确认离职" }));
    expect(
      await screen.findByText(
        /已为 bob 办理离职：注销 2 个会话，禁用 1 台设备/,
      ),
    ).toBeTruthy();
    expect(posts).toContain(`/admin/users/${leaver.id}/offboard`);
  });

  it("lists only the page's kinds in the market pages", async () => {
    renderAt("/skills", permissionsForRole("admin"));
    expect(await screen.findByText("代码评审")).toBeTruthy();
    expect(screen.queryByText("团队约定")).toBeNull();
  });

  it("shows a publisher select on the Skills page", async () => {
    renderAt("/skills", permissionsForRole("admin"));
    const select = (await screen.findByLabelText(
      "代码评审 创建人",
    )) as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(screen.getByRole("columnheader", { name: "创建人" })).toBeTruthy();
  });

  it.each([
    ["/providers", "设备管理", "模型与网关", "openai-main"],
    ["/profiles", "设备管理", "配置方案", "还没有配置方案"],
    ["/retention", "会话", "留存策略", "已开启：客户端每天同步一次对话"],
  ])("redirects %s to its tab", async (path, title, tab, content) => {
    renderAt(path, permissionsForRole("admin"));
    expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: tab }).getAttribute("aria-selected"),
    ).toBe("true");
    expect((await screen.findAllByText(content)).length).toBeGreaterThan(0);
  });

  it("redirects /market to Skills", async () => {
    renderAt("/market", permissionsForRole("admin"));
    expect(await screen.findByRole("heading", { name: "Skills" })).toBeTruthy();
    expect(await screen.findByText("代码评审")).toBeTruthy();
  });

  it("switches tabs through the tab bar", async () => {
    renderAt("/devices", permissionsForRole("admin"));
    expect(await screen.findByText("还没有电脑上报")).toBeTruthy();
    expect(tabNames()).toEqual(["设备", "配置方案", "模型与网关"]);
    fireEvent.click(screen.getByRole("tab", { name: "配置方案" }));
    expect(await screen.findByText("还没有配置方案")).toBeTruthy();
    expect(screen.queryByText("还没有电脑上报")).toBeNull();
  });

  it("shows only the device tabs the account may use", async () => {
    renderAt("/devices?tab=devices", ["providers.manage"]);
    expect(await screen.findByText("openai-main")).toBeTruthy();
    expect(tabNames()).toEqual(["模型与网关"]);
    expect(screen.queryByText("还没有电脑上报")).toBeNull();
  });

  it("hides the providers tab without providers.manage", async () => {
    renderAt("/devices?tab=providers", ["settings.manage"]);
    expect(await screen.findByText("还没有电脑上报")).toBeTruthy();
    expect(tabNames()).toEqual(["设备", "配置方案"]);
  });

  it("keeps device details behind settings.manage", async () => {
    renderAt("/devices/d1", ["providers.manage"]);
    expect(await screen.findByText("当前账号无权访问此页面。")).toBeTruthy();
  });

  it("shows 无管理权限 to members", async () => {
    renderAt("/", permissionsForRole("member"));
    expect(await screen.findByText("无管理权限")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "用户管理" })).toBeNull();
  });

  it("makes the retention policy read-only without settings.manage", async () => {
    renderAt("/conversations?tab=retention", ["audit.read"]);
    expect(await screen.findByText(/只读/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  });
});
