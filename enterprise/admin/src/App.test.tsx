import {
  CODING_PLAN_ACCOUNT_ID,
  type Permission,
  permissionsForRole,
  type SessionResponse,
  type User,
} from "@ccse/contracts";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
  adminMenus: null,
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
  "/admin/user-options": { items: [admin, leaver, departed] },
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
        allowedUserIds: [],
        allowedGroups: ["Dev"],
        dailyTokenLimitPerUser: null,
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  },
  "/admin/usage/devices": { items: [] },
  "/admin/usage/account-costs": {
    configured: true,
    unpricedCount: 0,
    history: [
      {
        month: new Date()
          .toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
          .slice(0, 7),
        items: [
          {
            department: "运营部-EZARC",
            monthlyUsd: 120,
            accountCount: 2,
            unpricedCount: 0,
          },
        ],
      },
    ],
    items: [
      {
        department: "运营部-EZARC",
        monthlyUsd: 120,
        accountCount: 2,
        unpricedCount: 0,
      },
      {
        department: "技术部&独立站&TK",
        monthlyUsd: 80,
        accountCount: 4,
        unpricedCount: 0,
      },
      {
        department: "运营部-LIBRATON",
        monthlyUsd: 40,
        accountCount: 2,
        unpricedCount: 0,
      },
    ],
  },
  "/admin/upstream/accounts": {
    configured: true,
    codingPlanAvailable: true,
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
  "/admin/usage/coding-plan": {
    configured: false,
    providerId: "volcengine-coding",
    fetchedAt: null,
    sourceUpdatedAt: null,
    status: null,
    stale: false,
    error: null,
    warning: null,
    subscription: null,
    windows: [],
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
      {
        date: "2026-10-12",
        userId: leaver.id,
        username: "bob",
        groupName: "研发",
        providerId: "yida-sub2api",
        model: "gpt-5.6-terra",
        requests: 5,
        inputTokens: 4000,
        outputTokens: 100,
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

function sessionFor(
  permissions: Permission[],
  user: User = admin,
): SessionResponse {
  return {
    accessToken: "a",
    accessTokenExpiresAt: "2026-01-01T00:15:00.000Z",
    refreshToken: "r1",
    refreshTokenExpiresAt: "2026-02-01T00:00:00.000Z",
    user,
    permissions,
  };
}

function renderAt(
  path: string,
  permissions: Permission[],
  user: User = admin,
  override?: (route: string, init?: RequestInit) => Response | undefined,
) {
  const posts: string[] = [];
  const patches: unknown[] = [];
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const route = url.pathname.replace(/^\/api\/v1/, "");
    if (route === "/auth/refresh") {
      return Response.json(sessionFor(permissions, user));
    }
    if (init?.method === "POST") posts.push(route);
    if (init?.method === "PATCH" && route === `/admin/users/${leaver.id}`) {
      const body = JSON.parse(String(init.body));
      patches.push(body);
      return Response.json({ ...leaver, ...body });
    }
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
    const custom = override?.(route, init);
    if (custom) return custom;
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
  return { posts, patches };
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
  it.each(["edit", "bulk"])(
    "saves a Coding Plan usage-window assignment from %s",
    async (mode) => {
      const { patches } = renderAt("/users", permissionsForRole("admin"));
      await screen.findByText("bob");
      if (mode === "bulk") {
        fireEvent.click(screen.getByRole("checkbox", { name: "选择 bob" }));
        fireEvent.click(screen.getByRole("button", { name: /设置用量窗口/ }));
      } else {
        const row = screen.getByText("bob").closest("tr");
        if (!row) throw new Error("Member row missing");
        fireEvent.click(within(row).getByRole("button", { name: "编辑" }));
      }
      const dialog = screen.getByRole("dialog");
      const checkbox = await within(dialog).findByRole("checkbox", {
        name: /Libraton-火山方舟Codin Plan/,
      });
      expect((checkbox as HTMLInputElement).disabled).toBe(false);
      fireEvent.click(checkbox);
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: mode === "bulk" ? "应用到 1 个用户" : "保存",
        }),
      );
      await waitFor(() =>
        expect(patches).toEqual([
          { upstreamAccountIds: [CODING_PLAN_ACCOUNT_ID] },
        ]),
      );
    },
  );

  const leader: User = {
    ...admin,
    role: "group_leader",
    groupName: "运营部-LIBRATON",
  };

  it("limits group leader editing to member/viewer roles", async () => {
    const { patches } = renderAt(
      "/users",
      permissionsForRole("group_leader"),
      leader,
    );
    await screen.findByText("bob");
    expect(screen.queryByRole("button", { name: "新建用户" })).toBeNull();
    expect(screen.queryByRole("button", { name: /设置用量窗口/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "离职" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    const adminRow = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("admin"));
    if (!adminRow) throw new Error("Admin row missing");
    expect(within(adminRow).queryByRole("button", { name: "编辑" })).toBeNull();
    const memberRow = screen.getByText("bob").closest("tr");
    if (!memberRow) throw new Error("Member row missing");
    fireEvent.click(within(memberRow).getByRole("button", { name: "编辑" }));
    const dialog = screen.getByRole("dialog");
    const role = within(dialog).getByLabelText("角色");
    expect(
      [...role.querySelectorAll("option")].map((o) => o.textContent),
    ).toEqual(["成员", "只读"]);
    expect(within(dialog).queryByLabelText("重置密码")).toBeNull();
    expect(within(dialog).queryByText("用量窗口")).toBeNull();
    expect(
      (within(dialog).getByLabelText("组") as HTMLInputElement).readOnly,
    ).toBe(true);
    fireEvent.change(role, { target: { value: "viewer" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patches).toEqual([{ role: "viewer" }]));
  });

  it("fixes group leader usage to their group while allowing member selection", async () => {
    renderAt("/usage", permissionsForRole("group_leader"), leader);
    const group = await screen.findByRole("textbox", { name: "所属组" });
    expect((group as HTMLInputElement).value).toBe("运营部-LIBRATON");
    expect((group as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "按组筛选" })).toBeNull();
    await screen.findByRole("figure", { name: "按用户 tokens" });
    fireEvent.click(screen.getByRole("button", { name: "按用户筛选" }));
    expect(await screen.findByRole("option", { name: "bob" })).toBeTruthy();
  });

  it("shows group leaders only their own department statistics without an editor or department switch", async () => {
    const current = new Date()
      .toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
      .slice(0, 7);
    const own = {
      department: "运营部-LIBRATON",
      monthlyUsd: 40,
      accountCount: 2,
      unpricedCount: 0,
    };
    renderAt("/usage", permissionsForRole("group_leader"), leader, (route) =>
      route === "/admin/usage/account-costs"
        ? Response.json({
            configured: true,
            departmentScope: "运营部-LIBRATON",
            items: [own],
            unpricedCount: 0,
            history: [{ month: current, items: [own] }],
          })
        : undefined,
    );
    expect(
      await screen.findByRole("heading", { name: "账户统计" }),
    ).toBeTruthy();
    await screen.findByRole("group", { name: "部门订阅费用趋势图" });
    expect(screen.getAllByText("$40.00").length).toBeGreaterThan(0);
    expect(screen.queryByRole("combobox", { name: "费用部门" })).toBeNull();
    expect(screen.queryByRole("button", { name: "补充计费信息" })).toBeNull();
    expect(screen.queryByText("$120.00")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "折线图" }));
    expect(
      await screen.findByRole("group", { name: "订阅费用折线图" }),
    ).toBeTruthy();
  });

  it("shows account statistics to the Leader role", async () => {
    const usageLeader: User = {
      ...admin,
      role: "leader",
      adminMenus: ["usage"],
    };
    renderAt("/usage", ["usage.read"], usageLeader, (route) =>
      route === "/admin/usage/account-costs"
        ? Response.json({
            configured: true,
            demo: true,
            items: [],
            unpricedCount: 1,
            manualAccounts: [
              {
                accountId: 99,
                name: "Unknown-GPT",
                platform: "openai",
                planType: null,
                department: "技术部&独立站&TK",
                monthlyUsd: null,
              },
            ],
          })
        : undefined,
    );
    expect(
      await screen.findByRole("heading", { name: "账户统计" }),
    ).toBeTruthy();
    await screen.findByText("所选期间或部门暂无费用记录。");
    expect(screen.queryByRole("button", { name: "补充计费信息" })).toBeNull();
    expect(screen.queryByText(/当月记录随上游账号更新/)).toBeNull();
    expect(screen.queryByText(/总计仅包含已计价费用/)).toBeNull();
    expect(screen.queryByText(/本机模拟账号/)).toBeNull();
  });

  it("lets admins assign the group leader role", async () => {
    renderAt("/users", permissionsForRole("admin"));
    await screen.findByText("bob");
    const memberRow = screen.getByText("bob").closest("tr");
    if (!memberRow) throw new Error("Member row missing");
    fireEvent.click(within(memberRow).getByRole("button", { name: "编辑" }));
    const role = within(screen.getByRole("dialog")).getByLabelText("角色");
    expect(
      [...role.querySelectorAll("option")].map((o) => o.textContent),
    ).toEqual(["管理员", "组长", "Leader", "成员", "只读"]);
  });

  it.each([
    ["/users", "用户管理", "admin"],
    ["/devices", "设备管理", "还没有电脑上报"],
    ["/devices?tab=profiles", "设备管理", "还没有配置方案"],
    ["/devices?tab=providers", "设备管理", "openai-main"],
    ["/usage", "用量统计", "按用户 tokens"],
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

  it("displays account costs for monthly and yearly queries", async () => {
    renderAt("/usage", permissionsForRole("admin"));
    expect(await screen.findByText("$240.00")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "编辑费用" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "按年" }));
    expect(await screen.findByText("$240.00")).toBeTruthy();
  });

  it("filters subscription totals and bars by department", async () => {
    renderAt("/usage", permissionsForRole("admin"));
    await screen.findByText("$240.00");
    fireEvent.change(screen.getByRole("combobox", { name: "费用部门" }), {
      target: { value: "运营部-EZARC" },
    });
    await waitFor(() => expect(screen.getAllByText("$120.00")).toHaveLength(2));
    expect(screen.queryByText("$80.00")).toBeNull();
    expect(screen.queryByText("$40.00")).toBeNull();
  });

  it("shows all months for one department and compares all recorded years without redundant filters", async () => {
    const currentYear = new Date()
      .toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
      .slice(0, 4);
    const priorYear = String(Number(currentYear) - 1);
    const item = (monthlyUsd: number) => ({
      department: "运营部-EZARC",
      monthlyUsd,
      accountCount: 2,
      unpricedCount: 0,
    });
    renderAt("/usage", permissionsForRole("admin"), admin, (route) =>
      route === "/admin/usage/account-costs"
        ? Response.json({
            configured: true,
            unpricedCount: 0,
            items: [item(60)],
            history: [
              { month: `${priorYear}-01`, items: [item(20)] },
              { month: `${currentYear}-01`, items: [item(40)] },
              { month: `${currentYear}-02`, items: [item(60)] },
            ],
          })
        : undefined,
    );
    await screen.findAllByText("$60.00");
    fireEvent.change(screen.getByRole("combobox", { name: "费用部门" }), {
      target: { value: "运营部-EZARC" },
    });
    const chart = await screen.findByRole("group", {
      name: "部门订阅费用趋势图",
    });
    expect(within(chart).getByText("1月")).toBeTruthy();
    expect(within(chart).getByText("12月")).toBeTruthy();
    expect(within(chart).getByText("$40.00")).toBeTruthy();
    expect(within(chart).getByText("$60.00")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "费用月份" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "费用年份" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "按年" }));
    expect(screen.queryByRole("combobox", { name: "费用年份" })).toBeNull();
    expect(within(chart).getByText(`${priorYear}年`)).toBeTruthy();
    expect(within(chart).getByText(`${currentYear}年`)).toBeTruthy();
    expect(within(chart).getAllByText("$100.00").length).toBeGreaterThan(0);
    expect(screen.queryByText(/账号月数/)).toBeNull();
  });

  it("switches chart types without losing department filters and keeps missing months as gaps", async () => {
    const currentYear = new Date()
      .toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
      .slice(0, 4);
    const item = (monthlyUsd: number) => ({
      department: "运营部-EZARC",
      monthlyUsd,
      accountCount: 2,
      unpricedCount: 0,
    });
    renderAt("/usage", permissionsForRole("admin"), admin, (route) =>
      route === "/admin/usage/account-costs"
        ? Response.json({
            configured: true,
            unpricedCount: 0,
            items: [item(90)],
            history: [
              { month: `${currentYear}-01`, items: [item(40)] },
              { month: `${currentYear}-02`, items: [item(60)] },
              { month: `${currentYear}-04`, items: [item(90)] },
            ],
          })
        : undefined,
    );
    await screen.findAllByText("$90.00");
    fireEvent.change(screen.getByRole("combobox", { name: "费用部门" }), {
      target: { value: "运营部-EZARC" },
    });
    fireEvent.click(screen.getByRole("button", { name: "折线图" }));
    const chart = await screen.findByRole("group", { name: "订阅费用折线图" });
    expect(chart.querySelectorAll('path[fill="none"]')).toHaveLength(1);
    const january = within(chart).getByRole("button", { name: /1月：/ });
    fireEvent.focus(january);
    expect(within(chart).getByText("$40.00")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "费用月份" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "柱状图" }));
    expect(
      await screen.findByRole("group", { name: "部门订阅费用趋势图" }),
    ).toBeTruthy();
    expect(screen.queryByRole("group", { name: "订阅费用折线图" })).toBeNull();
  });

  it("plots a separate time series per department in the all-department line chart", async () => {
    const year = new Date()
      .toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
      .slice(0, 4);
    const previous = String(Number(year) - 1);
    const items = (a: number, b: number) => [
      {
        department: "运营部-EZARC",
        monthlyUsd: a,
        accountCount: 2,
        unpricedCount: 0,
      },
      {
        department: "产品部",
        monthlyUsd: b,
        accountCount: 1,
        unpricedCount: 0,
      },
    ];
    renderAt("/usage", permissionsForRole("admin"), admin, (route) =>
      route === "/admin/usage/account-costs"
        ? Response.json({
            configured: true,
            unpricedCount: 0,
            items: items(60, 30),
            history: [
              { month: `${previous}-01`, items: items(20, 10) },
              { month: `${year}-01`, items: items(40, 20) },
              { month: `${year}-02`, items: items(60, 30) },
            ],
          })
        : undefined,
    );
    await screen.findByText("$90.00");
    fireEvent.click(screen.getByRole("button", { name: "折线图" }));
    const chart = await screen.findByRole("group", {
      name: "全部部门费用趋势图",
    });
    expect(within(chart).getByText("1月")).toBeTruthy();
    expect(within(chart).getByText("12月")).toBeTruthy();
    const series = chart.querySelectorAll("[data-series]");
    expect(series).toHaveLength(2);
    expect(series[0]?.getAttribute("style")).not.toBe(
      series[1]?.getAttribute("style"),
    );
    expect(chart.querySelectorAll('path[fill="none"]')).toHaveLength(2);
    expect(screen.queryByRole("combobox", { name: "费用月份" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "费用年份" })).toBeTruthy();
    expect(screen.getByText("$150.00")).toBeTruthy();
    fireEvent.click(
      within(screen.getByRole("group", { name: "部门曲线图例" })).getByRole(
        "button",
        { name: "产品部" },
      ),
    );
    expect(chart.querySelectorAll("[data-series]")).toHaveLength(1);
    expect(screen.getByText("$150.00")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "按年" }));
    expect(screen.queryByRole("combobox", { name: "费用年份" })).toBeNull();
    expect(within(chart).getByText(`${previous}年`)).toBeTruthy();
    expect(
      within(chart).getByText(`${year}年`, { selector: "text" }),
    ).toBeTruthy();
    expect(screen.getByText("$180.00")).toBeTruthy();
  });

  it("sorts active-period details by cost and exposes every department sharing a node", async () => {
    const year = new Date()
      .toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
      .slice(0, 4);
    const items = (a: number, b: number, c: number) => [
      {
        department: "运营部-EZARC",
        monthlyUsd: a,
        accountCount: 2,
        unpricedCount: 0,
      },
      {
        department: "产品部",
        monthlyUsd: b,
        accountCount: 1,
        unpricedCount: 0,
      },
      {
        department: "运营部-YPLUS",
        monthlyUsd: c,
        accountCount: 1,
        unpricedCount: 0,
      },
    ];
    renderAt("/usage", permissionsForRole("admin"), admin, (route) =>
      route === "/admin/usage/account-costs"
        ? Response.json({
            configured: true,
            unpricedCount: 0,
            items: items(120, 20, 20),
            history: [
              { month: `${year}-01`, items: items(10, 80, 20) },
              { month: `${year}-02`, items: items(120, 20, 20) },
            ],
          })
        : undefined,
    );
    await screen.findByText("$160.00");
    fireEvent.click(screen.getByRole("button", { name: "折线图" }));
    const chart = await screen.findByRole("group", {
      name: "全部部门费用趋势图",
    });
    const details = within(chart).getByRole("group", {
      name: "当期部门费用明细",
    });
    const order = () =>
      Array.from(details.querySelectorAll("[data-cost-detail]")).map((node) =>
        node.getAttribute("data-cost-detail"),
      );
    expect(order()[0]).toBe("运营部-EZARC");
    const february = within(chart).getByRole("button", {
      name: "2月，查看所有部门费用",
    });
    fireEvent.mouseEnter(february);
    expect(within(details).getAllByText("同额")).toHaveLength(2);
    const markers = chart.querySelectorAll(
      `[data-cost-marker][data-period="${year}-02"]`,
    );
    expect(markers).toHaveLength(2);
    expect(
      Array.from(markers).every((marker) => marker.getAttribute("r") === "4"),
    ).toBe(true);
    expect(
      chart.querySelector(
        `[data-cost-marker="产品部、运营部-YPLUS"][data-period="${year}-02"]`,
      ),
    ).toBeTruthy();
    const svg = within(chart).getByRole("group", {
      name: "各部门按时间排列的费用曲线",
    });
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 912,
      bottom: 282,
      width: 912,
      height: 282,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.mouseMove(svg, { clientX: 138, clientY: 40 });
    const februaryOrder = order();
    fireEvent.mouseMove(svg, { clientX: 138, clientY: 220 });
    expect(order()).toEqual(februaryOrder);
    expect(within(details).getByText("2月")).toBeTruthy();
    expect(details.className).toContain("h-64");
    expect(
      Array.from(markers).every((marker) => marker.getAttribute("r") === "4"),
    ).toBe(true);
    fireEvent.mouseMove(svg, { clientX: 138, clientY: 200 });
    const sharedTip = screen.getByRole("tooltip");
    expect(within(sharedTip).getByText("产品部")).toBeTruthy();
    expect(within(sharedTip).getByText("运营部-YPLUS")).toBeTruthy();
    expect(within(sharedTip).getAllByText("$20.00")).toHaveLength(2);
    expect(
      sharedTip.closest("foreignObject")?.getAttribute("pointer-events"),
    ).toBe("none");
    fireEvent.mouseMove(svg, { clientX: 138, clientY: 68 });
    const individualTip = screen.getByRole("tooltip");
    expect(within(individualTip).getByText("运营部-EZARC")).toBeTruthy();
    expect(within(individualTip).queryByText("产品部")).toBeNull();
    fireEvent.mouseLeave(svg);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseMove(svg, { clientX: 64, clientY: 100 });
    expect(order()).toEqual(["产品部", "运营部-YPLUS", "运营部-EZARC"]);
  });

  it("edits an unrecognized monthly fee in a dialog and refreshes the total", async () => {
    let monthlyUsd: number | null = null;
    renderAt("/usage", permissionsForRole("admin"), admin, (route, init) => {
      if (route === "/admin/usage/account-costs/manual") {
        monthlyUsd = JSON.parse(String(init?.body)).items[0].monthlyUsd;
        return new Response(null, { status: 204 });
      }
      if (route === "/admin/usage/account-costs")
        return Response.json({
          configured: true,
          unpricedCount: monthlyUsd === null ? 1 : 0,
          items: [
            {
              department: "技术部&独立站&TK",
              monthlyUsd: monthlyUsd ?? 0,
              accountCount: 1,
              unpricedCount: monthlyUsd === null ? 1 : 0,
            },
          ],
          manualAccounts: [
            {
              accountId: 99,
              name: "Unknown-GPT",
              platform: "openai",
              planType: null,
              department: "技术部&独立站&TK",
              monthlyUsd,
            },
          ],
        });
      return undefined;
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "补充计费信息" }),
    );
    const dialog = screen.getByRole("dialog", { name: "编辑未识别套餐费用" });
    fireEvent.change(within(dialog).getByLabelText("每月费用（USD）"), {
      target: { value: "35.50" },
    });
    fireEvent.submit(document.getElementById("manual-account-costs")!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(monthlyUsd).toBe(35.5);
    expect(screen.getAllByText("$35.50")).toHaveLength(2);
    expect(
      await screen.findByText(
        "未识别套餐的费用已补充，可查看已填写的计费信息。",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "查看计费信息" })).toBeTruthy();
  });

  it("switches token charts between users, departments and models with active filters", async () => {
    const base = {
      date: "2026-10-12",
      userId: "alice",
      username: "alice",
      groupName: "研发",
      providerId: "openai-main",
      model: "gpt-5",
      requests: 1,
      inputTokens: 1200,
      outputTokens: 300,
    };
    renderAt("/usage", permissionsForRole("admin"), admin, (route) =>
      route === "/admin/usage"
        ? Response.json({
            items: [
              base,
              {
                ...base,
                date: "2026-10-13",
                providerId: "yida-sub2api",
                model: "gpt-5.6-terra",
                inputTokens: 800,
                outputTokens: 200,
              },
              {
                ...base,
                userId: "bob",
                username: "bob",
                providerId: "yida-sub2api",
                inputTokens: 4000,
                outputTokens: 100,
              },
              {
                ...base,
                userId: "carol",
                username: "carol",
                groupName: "设计",
                inputTokens: 700,
              },
              {
                ...base,
                userId: admin.id,
                username: "admin",
                groupName: "",
                inputTokens: 50,
                outputTokens: 10,
              },
            ],
          })
        : undefined,
    );
    const userChart = await screen.findByRole("figure", {
      name: "按用户 tokens",
    });
    expect(
      within(userChart).getByTitle("alice：输入 2,000，输出 500"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "按用户 tokens" }));
    fireEvent.click(
      within(screen.getByRole("listbox")).getByRole("option", {
        name: "按部门 tokens",
      }),
    );
    const departments = () =>
      screen.getByRole("figure", { name: "按部门 tokens" });
    expect(
      within(departments()).getByTitle("研发：输入 6,000，输出 600"),
    ).toBeTruthy();
    expect(within(departments()).getByTitle("6,600 tokens")).toBeTruthy();
    expect(
      within(departments())
        .getAllByText(/^(研发|设计|未分组)$/)
        .map((node) => node.textContent),
    ).toEqual(["研发", "设计", "未分组"]);
    expect(
      within(departments()).getByTitle("未分组：输入 50，输出 10"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "按部门 tokens" }));
    fireEvent.click(
      within(screen.getByRole("listbox")).getByRole("option", {
        name: "按模型 tokens",
      }),
    );
    const models = screen.getByRole("figure", { name: "按模型 tokens" });
    expect(
      within(models).getByTitle("gpt-5 · openai-main：输入 1,950，输出 610"),
    ).toBeTruthy();
    expect(
      within(models)
        .getAllByRole("group")
        .map((node) => node.getAttribute("aria-label")),
    ).toEqual([
      "gpt-5 · yida-sub2api",
      "gpt-5 · openai-main",
      "gpt-5.6-terra · yida-sub2api",
    ]);
    expect(screen.queryByRole("table", { name: "按用户汇总" })).toBeNull();
    expect(screen.queryByRole("table", { name: "按模型汇总" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "按用户汇总" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "按模型汇总" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "按模型 tokens" }));
    fireEvent.click(
      within(screen.getByRole("listbox")).getByRole("option", {
        name: "按部门 tokens",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "按供应商筛选" }));
    fireEvent.click(screen.getByRole("option", { name: "openai-main" }));
    expect(
      within(departments()).getByTitle("研发：输入 1,200，输出 300"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "按用户筛选" }));
    fireEvent.click(screen.getByRole("option", { name: "alice" }));
    expect(within(departments()).queryByText("设计")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "清空筛选" }));
    expect(within(departments()).getByTitle("6,600 tokens")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "按组筛选" }));
    fireEvent.click(screen.getByRole("option", { name: "设计" }));
    expect(within(departments()).queryByText("研发")).toBeNull();
    const tokenSelector = screen.getByRole("button", { name: "按部门 tokens" });
    fireEvent.mouseDown(tokenSelector);
    fireEvent.click(tokenSelector);
    fireEvent.click(
      within(screen.getByRole("listbox")).getByRole("option", {
        name: "按用户 tokens",
      }),
    );
    const filteredUsers = screen.getByRole("figure", { name: "按用户 tokens" });
    expect(within(filteredUsers).getByText("carol")).toBeTruthy();
    expect(within(filteredUsers).queryByText("bob")).toBeNull();
    fireEvent.change(
      screen.getByRole("combobox", { name: "tokens 统计维度" }),
      {
        target: { value: "model" },
      },
    );
    const filteredModels = screen.getByRole("figure", {
      name: "按模型 tokens",
    });
    expect(within(filteredModels).getAllByRole("group")).toHaveLength(1);
    expect(
      within(filteredModels).getByTitle(
        "gpt-5 · openai-main：输入 700，输出 300",
      ),
    ).toBeTruthy();
  });

  it("shows only tokens in all chart dimensions while keeping costs in details", async () => {
    const base = {
      date: "2026-10-26",
      userId: "alice",
      username: "alice",
      groupName: "研发",
      providerId: "main",
      model: "gpt-6-luna",
      requests: 1,
      inputTokens: 1000,
      outputTokens: 100,
      estimatedCostUsd: 1.25,
      unpricedRequests: 0,
      legacyRequests: 1,
    };
    renderAt("/usage", permissionsForRole("admin"), admin, (route) =>
      route === "/admin/usage"
        ? Response.json({
            items: [
              base,
              {
                ...base,
                date: "2026-10-25",
                estimatedCostUsd: 2.5,
                legacyRequests: 0,
              },
              {
                ...base,
                model: "unknown-model",
                estimatedCostUsd: null,
                unpricedRequests: 1,
              },
              {
                ...base,
                userId: "bob",
                username: "bob",
                model: "unknown-model",
                estimatedCostUsd: null,
                unpricedRequests: 1,
              },
            ],
          })
        : undefined,
    );
    const users = await screen.findByRole("figure", { name: "按用户 tokens" });
    const details = screen.getByRole("table", { name: "明细" });
    expect(
      within(details).getAllByRole("columnheader").at(-1)?.textContent,
    ).toBe("估算费用（USD）");
    const alice = within(users).getByRole("group", { name: "alice" });
    expect(within(alice).getByTitle("3,300 tokens")).toBeTruthy();
    for (const [value, label] of [
      ["user", "按用户 tokens"],
      ["department", "按部门 tokens"],
      ["model", "按模型 tokens"],
    ]) {
      fireEvent.change(
        screen.getByRole("combobox", { name: "tokens 统计维度" }),
        { target: { value } },
      );
      const chart = screen.getByRole("figure", { name: label });
      expect(within(chart).queryByLabelText("估算费用（USD）")).toBeNull();
      expect(within(chart).queryByText(/\$|未计价|（部分）/)).toBeNull();
    }
    const models = screen.getByRole("figure", { name: "按模型 tokens" });
    expect(within(models).getAllByTitle("2,200 tokens")).toHaveLength(2);
    expect(within(details).getByText("$1.25")).toBeTruthy();
    expect(within(details).getByText("$2.50")).toBeTruthy();
    expect(screen.getByText(/旧记录未采集缓存写入和上游计价模型/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "按用户筛选" }));
    fireEvent.click(await screen.findByRole("option", { name: "bob" }));
    expect(within(models).getByTitle("1,100 tokens")).toBeTruthy();
    expect(within(details).getByText("未计价")).toBeTruthy();
    expect(within(details).queryByText("$1.25")).toBeNull();
  });

  it("sums chart tokens over all detail pages while keeping costs in each detail row", async () => {
    renderAt("/usage", permissionsForRole("admin"), admin, (route) =>
      route === "/admin/usage"
        ? Response.json({
            items: Array.from({ length: 11 }, (_, i) => ({
              date: `2026-10-${String(i + 1).padStart(2, "0")}`,
              userId: "alice",
              username: "alice",
              providerId: "main",
              model: "gpt-6-luna",
              requests: 1,
              inputTokens: 1000,
              outputTokens: 100,
              estimatedCostUsd: 0.01,
            })),
          })
        : undefined,
    );
    const users = await screen.findByRole("figure", { name: "按用户 tokens" });
    const details = screen.getByRole("table", { name: "明细" });
    expect(within(users).getByTitle("12,100 tokens")).toBeTruthy();
    expect(within(details).getAllByText("$0.01")).toHaveLength(10);
    const card = details.parentElement;
    if (!card) throw new Error("missing detail card");
    fireEvent.click(within(card).getByRole("button", { name: "下一页" }));
    expect(within(details).getAllByText("$0.01")).toHaveLength(1);
    expect(within(users).getByTitle("12,100 tokens")).toBeTruthy();
    fireEvent.change(
      screen.getByRole("combobox", { name: "tokens 统计维度" }),
      {
        target: { value: "model" },
      },
    );
    const models = screen.getByRole("figure", { name: "按模型 tokens" });
    expect(within(models).getByTitle("12,100 tokens")).toBeTruthy();
    expect(within(models).queryByText(/\$/)).toBeNull();
  });

  it("filters usage by user, group and provider", async () => {
    renderAt("/usage", permissionsForRole("admin"));
    expect(
      (await screen.findAllByText("gpt-5.6-terra")).length,
    ).toBeGreaterThan(0);
    const requests = () =>
      screen.getByText("请求数", { selector: "div" }).nextElementSibling
        ?.textContent;
    expect(requests()).toBe("8 次");

    fireEvent.click(screen.getByRole("button", { name: "按组筛选" }));
    fireEvent.click(await screen.findByRole("option", { name: "研发" }));
    expect(requests()).toBe("5 次");
    expect(screen.queryAllByText("gpt-5")).toHaveLength(0);

    // Ungrouped admin + 研发 bob, then narrow to one provider.
    fireEvent.click(screen.getByRole("option", { name: "未分组" }));
    expect(requests()).toBe("8 次");
    fireEvent.click(screen.getByRole("button", { name: "按供应商筛选" }));
    fireEvent.click(await screen.findByRole("option", { name: "openai-main" }));
    expect(requests()).toBe("3 次");

    fireEvent.click(screen.getByRole("button", { name: "按用户筛选" }));
    fireEvent.click(await screen.findByRole("option", { name: "bob" }));
    expect(await screen.findByText("没有符合筛选条件的用量")).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole("button", { name: "清空筛选" })[0] as HTMLElement,
    );
    expect((await screen.findAllByText("gpt-5")).length).toBeGreaterThan(0);
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
