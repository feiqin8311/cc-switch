import { CODING_PLAN_ACCOUNT_ID, type User } from "@ccse/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast";
import { USERS_KEY, UsersPage } from "./UsersPage";

const { get, request } = vi.hoisted(() => ({
  get: vi.fn(),
  request: vi.fn(),
}));

vi.mock("../lib/auth", () => ({
  useApi: () => ({ get, request }),
  useSession: () => ({ user: admin, permissions: ["users.manage"] }),
  useAuth: () => ({ patchCurrentUser: vi.fn() }),
}));

const admin: User = {
  id: "admin",
  username: "admin",
  displayName: "",
  role: "admin",
  groupName: "研发",
  disabled: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  lastLoginAt: null,
  upstreamAccountIds: [],
  offboardedAt: null,
  offboardedBy: null,
};

const members: User[] = [
  { ...admin, id: "alice", username: "alice", role: "member" },
  { ...admin, id: "bob", username: "bob", role: "member" },
  {
    ...admin,
    id: "carol",
    username: "carol",
    role: "member",
    groupName: "设计",
  },
  {
    ...admin,
    id: "dave",
    username: "dave",
    role: "member",
    groupName: "",
  },
];
const users = [admin, ...members];

afterEach(() => vi.clearAllMocks());

async function show() {
  get.mockResolvedValue({ items: users });
  request.mockImplementation(async (path: string) => {
    if (path === "/admin/upstream/accounts") {
      return { items: [], codingPlanAvailable: true };
    }
    return users.find((u) => path === `/admin/users/${u.id}`);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <UsersPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole("checkbox", { name: "选择 alice" });
  return client;
}

function filterBy(label: string) {
  const select = screen.getByRole("combobox", { name: "按组筛选" });
  const current = (select as HTMLSelectElement).selectedOptions[0]?.textContent;
  if (!current) throw new Error("Group filter has no selected option");
  fireEvent.click(screen.getByRole("button", { name: current }));
  fireEvent.click(
    within(screen.getByRole("listbox")).getByRole("option", { name: label }),
  );
}

describe("user group filtering", () => {
  it("filters named and ungrouped users and restores the full list", async () => {
    await show();
    expect(screen.getAllByRole("row")).toHaveLength(6);
    filterBy("研发");
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.queryByRole("checkbox", { name: "选择 carol" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "选择 dave" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("显示 3 / 5 位用户");

    filterBy("未分组");
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByRole("checkbox", { name: "选择 dave" })).toBeTruthy();

    filterBy("全部组");
    expect(screen.getAllByRole("row")).toHaveLength(6);
  });

  it("selects only the filtered group for bulk edits and still skips admins", async () => {
    await show();
    filterBy("研发");
    fireEvent.click(screen.getByRole("checkbox", { name: "全选" }));
    fireEvent.click(screen.getByRole("button", { name: "设置用量窗口 (3)" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/已跳过 1 个管理员/)).toBeTruthy();
    fireEvent.click(
      await within(dialog).findByRole("checkbox", {
        name: /火山方舟 Coding Plan/,
      }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "应用到 2 个用户" }),
    );
    await waitFor(() => {
      const patches = request.mock.calls.filter(
        ([, init]) => init.method === "PATCH",
      );
      expect(patches.map(([path]) => path)).toEqual([
        "/admin/users/alice",
        "/admin/users/bob",
      ]);
      for (const [, init] of patches) {
        expect(init.body).toEqual({
          upstreamAccountIds: [CODING_PLAN_ACCOUNT_ID],
        });
      }
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("clears selections when switching groups and supports partial and full selection", async () => {
    await show();
    fireEvent.click(screen.getByRole("checkbox", { name: "全选" }));
    filterBy("研发");
    const bulk = () =>
      screen.getByRole("button", { name: /设置用量窗口/ }) as HTMLButtonElement;
    expect(bulk().disabled).toBe(true);
    const all = screen.getByRole("checkbox", {
      name: "全选",
    }) as HTMLInputElement;
    expect(all.checked).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 alice" }));
    expect(all.indeterminate).toBe(true);
    fireEvent.click(all);
    expect(all.checked).toBe(true);
    expect(bulk().textContent).toContain("(3)");
    fireEvent.click(all);
    expect(bulk().disabled).toBe(true);
    fireEvent.click(all);
    filterBy("设计");
    expect(bulk().disabled).toBe(true);
    filterBy("全部组");
    expect(
      screen
        .getAllByRole("checkbox")
        .every((c) => !(c as HTMLInputElement).checked),
    ).toBe(true);
  });

  it("excludes users who move out of the group when the list refreshes", async () => {
    const client = await show();
    filterBy("设计");
    fireEvent.click(screen.getByRole("checkbox", { name: "全选" }));
    act(() => {
      client.setQueryData(USERS_KEY, {
        items: users.map((u) =>
          u.id === "carol" ? { ...u, groupName: "研发" } : u,
        ),
      });
    });
    expect(await screen.findByText("没有符合筛选条件的用户")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: /设置用量窗口/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    filterBy("全部组");
    expect(screen.getByRole("checkbox", { name: "选择 carol" })).toBeTruthy();
  });
});
