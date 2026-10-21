import {
  CODING_PLAN_ACCOUNT_ID,
  type CreateUserRequest,
  ListUsersResponseSchema,
  OffboardUserResponseSchema,
  type Role,
  RoleSchema,
  type UpdateUserRequest,
  UpstreamAccountsResponseSchema,
  type User,
  UserSchema,
} from "@ccse/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Users as UsersIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useToast } from "../components/Toast";
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  InlineError,
  inputClass,
  LoadingState,
  Select,
  Spinner,
  Switch,
} from "../components/ui";
import { ApiError } from "../lib/api";
import { useApi, useAuth, useSession } from "../lib/auth";
import {
  describeError,
  fieldErrorsOf,
  formatDateTime,
  ROLE_LABELS,
} from "../lib/format";

export const USERS_KEY = ["admin", "users"] as const;

const ROLES = RoleSchema.options;
const USERNAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{1,31}$/u;

const userTh =
  "px-4 py-3 text-left text-[13px] font-medium text-muted-foreground";
const userTd = "px-4 py-4 align-middle text-sm leading-5";
const userTr =
  "border-b border-border/60 transition-colors last:border-b-0 hover:bg-muted/50";

export function useUsers(enabled = true) {
  const client = useApi();
  return useQuery({
    queryKey: USERS_KEY,
    queryFn: ({ signal }) =>
      client.get("/admin/users", ListUsersResponseSchema, signal),
    enabled,
  });
}

export function UsersPage() {
  const session = useSession();
  const isAdmin = session.permissions.includes("users.manage");
  const users = useUsers();
  const client = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [offboarding, setOffboarding] = useState<User | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const allUsers = users.data?.items ?? [];
  const groupNames = [
    ...new Set([
      ...allUsers.map((u) => u.groupName).filter(Boolean),
      ...(groupFilter ? [groupFilter] : []),
    ]),
  ].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const filteredUsers = allUsers.filter(
    (u) => groupFilter === null || u.groupName === groupFilter,
  );
  const selectedUsers = filteredUsers.filter((u) => selected.includes(u.id));

  const offboard = useMutation({
    mutationFn: (user: User) =>
      client.request(`/admin/users/${user.id}/offboard`, {
        method: "POST",
        schema: OffboardUserResponseSchema,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: USERS_KEY });
      toast.success(
        `已为 ${res.user.username} 办理离职：注销 ${res.revokedSessions} 个会话，禁用 ${res.disabledDevices} 台设备`,
      );
      setOffboarding(null);
    },
    onError: (err) => toast.error(`离职处理失败：${describeError(err)}`),
  });

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-serif text-[32px] font-normal leading-none tracking-tight text-foreground">
          用户管理
        </h1>
        <div className="mt-5 flex flex-col items-start gap-3">
          <p className="min-w-0 max-w-2xl text-sm leading-6 text-muted-foreground">
            {isAdmin
              ? "创建员工账号、分配角色、重置密码、禁用账号或办理离职。禁用、改角色、重置密码或离职会立即注销该用户的所有会话；离职会保留其用量和对话记录。"
              : "查看本组用户，可将本组成员的角色设置为成员或只读。修改角色会立即注销该用户的所有会话。"}
          </p>
          {isAdmin && (
            <div className="flex shrink-0 items-center gap-2">
              <Button
                className="font-normal shadow-none"
                disabled={selectedUsers.length === 0}
                onClick={() => setBulkOpen(true)}
              >
                设置用量窗口
                {selectedUsers.length > 0 ? ` (${selectedUsers.length})` : ""}
              </Button>
              <Button
                variant="primary"
                className="shadow-none"
                onClick={() => setCreating(true)}
              >
                <Plus className="size-3.5" />
                新建用户
              </Button>
            </div>
          )}
        </div>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label
          htmlFor="users-group-filter"
          className="text-sm text-muted-foreground"
        >
          筛选
        </label>
        <div className="w-48">
          <Select
            id="users-group-filter"
            aria-label="按组筛选"
            value={groupFilter === null ? "all" : `group:${groupFilter}`}
            options={[
              { value: "all", label: "全部组" },
              { value: "group:", label: "未分组" },
              ...groupNames.map((name) => ({
                value: `group:${name}`,
                label: name,
              })),
            ]}
            onChange={(value) => {
              setGroupFilter(value === "all" ? null : value.slice(6));
              setSelected([]);
            }}
            disabled={users.isPending || users.isError}
          />
        </div>
        {users.isSuccess && (
          <span className="text-xs text-muted-foreground" role="status">
            显示 {filteredUsers.length} / {allUsers.length} 位用户
          </span>
        )}
      </div>
      <div className="overflow-x-auto rounded-xl border border-border/80 bg-card">
        {users.isPending ? (
          <LoadingState />
        ) : users.isError ? (
          <ErrorState error={users.error} onRetry={() => users.refetch()} />
        ) : users.data.items.length === 0 ? (
          <EmptyState
            icon={<UsersIcon className="size-5 stroke-[1.5]" />}
            title="暂无用户"
          >
            暂无用户
          </EmptyState>
        ) : filteredUsers.length === 0 ? (
          <EmptyState
            icon={<UsersIcon className="size-5 stroke-[1.5]" />}
            title="没有符合筛选条件的用户"
          >
            请切换其他组或选择全部组。
          </EmptyState>
        ) : (
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-border/70">
                {isAdmin && (
                  <th className={`${userTh} w-10`}>
                    <input
                      type="checkbox"
                      className="size-3.5 accent-foreground"
                      aria-label="全选"
                      checked={
                        filteredUsers.length > 0 &&
                        selectedUsers.length === filteredUsers.length
                      }
                      ref={(input) => {
                        if (input)
                          input.indeterminate =
                            selectedUsers.length > 0 &&
                            selectedUsers.length < filteredUsers.length;
                      }}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? filteredUsers.map((u) => u.id)
                            : [],
                        )
                      }
                    />
                  </th>
                )}
                <th className={userTh}>用户名</th>
                <th className={userTh}>组</th>
                <th className={userTh}>角色</th>
                <th className={userTh}>用量窗口</th>
                <th className={userTh}>状态</th>
                <th className={userTh}>创建时间</th>
                <th className={userTh}>最近登录</th>
                <th className={`${userTh} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u) => (
                <tr key={u.id} className={userTr}>
                  {isAdmin && (
                    <td className={userTd}>
                      <input
                        type="checkbox"
                        className="size-3.5 accent-foreground"
                        aria-label={`选择 ${u.username}`}
                        checked={selected.includes(u.id)}
                        onChange={(e) =>
                          setSelected((prev) =>
                            e.target.checked
                              ? [...prev, u.id]
                              : prev.filter((id) => id !== u.id),
                          )
                        }
                      />
                    </td>
                  )}
                  <td className={`${userTd} font-medium`}>
                    {u.username}
                    {u.id === session.user.id && (
                      <span className="ml-1.5 font-normal text-muted-foreground">
                        我
                      </span>
                    )}
                  </td>
                  <td
                    className={`${userTd} ${u.groupName ? "" : "text-muted-foreground"}`}
                  >
                    {u.groupName || "—"}
                  </td>
                  <td
                    className={`${userTd} ${u.role === "admin" ? "font-medium" : "text-muted-foreground"}`}
                  >
                    {ROLE_LABELS[u.role]}
                  </td>
                  <td
                    className={`${userTd} ${
                      u.role === "admin" || u.upstreamAccountIds.length > 0
                        ? ""
                        : "text-muted-foreground"
                    }`}
                  >
                    {u.role === "admin"
                      ? "全部"
                      : u.upstreamAccountIds.length === 0
                        ? "无"
                        : `${u.upstreamAccountIds.length} 个账号`}
                  </td>
                  <td className={userTd}>
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className={`size-1.5 rounded-full ${
                          u.offboardedAt
                            ? "bg-muted-foreground"
                            : u.disabled
                              ? "bg-destructive"
                              : "bg-emerald-600"
                        }`}
                      />
                      {u.offboardedAt ? (
                        <span
                          title={`${formatDateTime(u.offboardedAt)} 由 ${u.offboardedBy ?? "—"} 办理`}
                        >
                          已离职
                        </span>
                      ) : u.disabled ? (
                        "已禁用"
                      ) : (
                        "正常"
                      )}
                    </span>
                  </td>
                  <td
                    className={`${userTd} whitespace-nowrap text-muted-foreground tabular-nums`}
                  >
                    {formatDateTime(u.createdAt)}
                  </td>
                  <td
                    className={`${userTd} whitespace-nowrap text-muted-foreground tabular-nums`}
                  >
                    {formatDateTime(u.lastLoginAt)}
                  </td>
                  <td className={`${userTd} text-right whitespace-nowrap`}>
                    <div className="inline-flex items-center justify-end gap-1">
                      {(isAdmin ||
                        u.role === "member" ||
                        u.role === "viewer") && (
                        <button
                          type="button"
                          onClick={() => setEditing(u)}
                          className="rounded-lg px-2 py-1 text-sm text-foreground hover:bg-muted"
                        >
                          编辑
                        </button>
                      )}
                      {isAdmin &&
                        u.id !== session.user.id &&
                        !u.offboardedAt && (
                          <button
                            type="button"
                            onClick={() => setOffboarding(u)}
                            className="rounded-lg px-2 py-1 text-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          >
                            离职
                          </button>
                        )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && <CreateUserDialog onClose={() => setCreating(false)} />}
      {bulkOpen && (
        <BulkWindowsDialog
          users={selectedUsers}
          onClose={() => setBulkOpen(false)}
          onDone={() => {
            setBulkOpen(false);
            setSelected([]);
          }}
        />
      )}
      {editing && (
        <EditUserDialog
          key={editing.id}
          user={editing}
          isSelf={editing.id === session.user.id}
          roleOnly={!isAdmin}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={offboarding !== null}
        title="办理离职"
        danger
        confirmLabel="确认离职"
        pending={offboard.isPending}
        message={
          <>
            确定为 <b>{offboarding?.username}</b>
            办理离职吗？该账号会被禁用并立即退出所有设备，其名下设备也会被禁用；用量和已留存的对话会保留，操作会记入审计。如需恢复，可在编辑中重新启用账号。
          </>
        }
        onCancel={() => setOffboarding(null)}
        onConfirm={() => offboarding && offboard.mutate(offboarding)}
      />
    </div>
  );
}

function RoleSelect({
  id,
  value,
  onChange,
  disabled,
  roles = ROLES,
}: {
  id: string;
  value: Role;
  onChange(role: Role): void;
  disabled?: boolean;
  roles?: readonly Role[];
}) {
  const options = roles.map((r) => ({
    value: r,
    label: ROLE_LABELS[r],
  }));
  return (
    <Select
      id={id}
      options={options}
      value={value}
      onChange={(v) => onChange(v as Role)}
      disabled={disabled}
      size="md"
    />
  );
}

function CreateUserDialog({ onClose }: { onClose(): void }) {
  const client = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<CreateUserRequest>({
    username: "",
    password: "",
    role: "member",
    groupName: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (body: CreateUserRequest) =>
      client.request("/admin/users", {
        method: "POST",
        body,
        schema: UserSchema,
      }),
    onSuccess: (user) => {
      qc.invalidateQueries({ queryKey: USERS_KEY });
      toast.success(`已创建用户 ${user.username}`);
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "conflict") {
        setErrors({ username: "用户名已存在" });
        return;
      }
      const fields = fieldErrorsOf(err);
      if (Object.keys(fields).length > 0) setErrors(fields);
      else setFormError(describeError(err));
    },
  });

  const set = <K extends keyof CreateUserRequest>(
    key: K,
    value: CreateUserRequest[K],
  ) => setForm((f) => ({ ...f, [key]: value }));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    const username = form.username.trim();
    if (!USERNAME_RE.test(username))
      next.username = "2-32 位，中文或字母数字，可含 '.'、'_'、'-'";
    if (form.password.length < 6 || form.password.length > 128)
      next.password = "密码长度需为 6-128 位";
    if ((form.groupName ?? "").trim().length > 64)
      next.groupName = "组名最多 64 个字符";
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0) return;
    create.mutate({
      ...form,
      username,
      groupName: (form.groupName ?? "").trim(),
    });
  };

  return (
    <Dialog
      open
      title="新建用户"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            type="submit"
            form="create-user-form"
            variant="primary"
            disabled={create.isPending}
          >
            {create.isPending && <Spinner className="size-3" />}
            创建
          </Button>
        </>
      }
    >
      <form
        id="create-user-form"
        noValidate
        onSubmit={onSubmit}
        className="grid grid-cols-2 gap-3"
      >
        <Field
          label="用户名"
          htmlFor="cu-username"
          required
          error={errors.username}
          hint="登录名，中英文均可，创建后不可修改"
        >
          <input
            id="cu-username"
            className={inputClass}
            aria-invalid={!!errors.username}
            autoComplete="off"
            value={form.username}
            onChange={(e) => set("username", e.target.value)}
          />
        </Field>
        <Field
          label="初始密码"
          htmlFor="cu-password"
          required
          error={errors.password}
          hint="至少 6 位"
        >
          <input
            id="cu-password"
            type="password"
            autoComplete="new-password"
            className={inputClass}
            aria-invalid={!!errors.password}
            value={form.password}
            onChange={(e) => set("password", e.target.value)}
          />
        </Field>
        <Field label="角色" htmlFor="cu-role" error={errors.role}>
          <RoleSelect
            id="cu-role"
            value={form.role}
            onChange={(r) => set("role", r)}
          />
        </Field>
        <Field
          label="组"
          htmlFor="cu-group"
          error={errors.groupName}
          hint="留空表示不分组"
        >
          <input
            id="cu-group"
            className={inputClass}
            aria-invalid={!!errors.groupName}
            value={form.groupName ?? ""}
            onChange={(e) => set("groupName", e.target.value)}
          />
        </Field>
        <div className="col-span-2">
          <InlineError>{formError}</InlineError>
        </div>
      </form>
    </Dialog>
  );
}

function EditUserDialog({
  user,
  isSelf,
  roleOnly = false,
  onClose,
}: {
  user: User;
  isSelf: boolean;
  roleOnly?: boolean;
  onClose(): void;
}) {
  const client = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const { patchCurrentUser } = useAuth();
  const [username, setUsername] = useState(user.username);
  const [groupName, setGroupName] = useState(user.groupName);
  const [role, setRole] = useState<Role>(user.role);
  const [disabled, setDisabled] = useState(user.disabled);
  const [password, setPassword] = useState("");
  const [upstreamAccountIds, setUpstreamAccountIds] = useState<number[]>(
    user.upstreamAccountIds,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: (body: UpdateUserRequest) =>
      client.request(`/admin/users/${user.id}`, {
        method: "PATCH",
        body,
        schema: UserSchema,
      }),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: USERS_KEY });
      patchCurrentUser(updated);
      toast.success(`已更新用户 ${updated.username}`);
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "conflict") {
        setErrors({ username: "用户名已存在" });
        return;
      }
      const fields = fieldErrorsOf(err);
      if (Object.keys(fields).length > 0) setErrors(fields);
      else setFormError(describeError(err));
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (roleOnly) {
      if (role === user.role) onClose();
      else update.mutate({ role });
      return;
    }
    const next: Record<string, string> = {};
    if (!USERNAME_RE.test(username.trim()))
      next.username = "2-32 位，中文或字母数字，可含 '.'、'_'、'-'";
    if (password && (password.length < 6 || password.length > 128))
      next.password = "密码长度需为 6-128 位";
    if (groupName.trim().length > 64) next.groupName = "组名最多 64 个字符";
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0) return;

    const body: UpdateUserRequest = {};
    if (username.trim() !== user.username) body.username = username.trim();
    if (groupName.trim() !== user.groupName) body.groupName = groupName.trim();
    if (!isSelf && role !== user.role) body.role = role;
    if (!isSelf && disabled !== user.disabled) body.disabled = disabled;
    if (password) body.password = password;
    const idsChanged =
      JSON.stringify([...upstreamAccountIds].sort()) !==
      JSON.stringify([...user.upstreamAccountIds].sort());
    if (idsChanged) body.upstreamAccountIds = upstreamAccountIds;
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    update.mutate(body);
  };

  return (
    <Dialog
      open
      title={`编辑用户 ${user.username}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            type="submit"
            form="edit-user-form"
            variant="primary"
            disabled={update.isPending}
          >
            {update.isPending && <Spinner className="size-3" />}
            保存
          </Button>
        </>
      }
    >
      <form
        id="edit-user-form"
        noValidate
        onSubmit={onSubmit}
        className="grid grid-cols-2 gap-3"
      >
        <Field
          label="用户名"
          htmlFor="eu-username"
          error={errors.username}
          hint={
            roleOnly ? undefined : "员工用新用户名登录，已登录的设备不受影响"
          }
          className="col-span-2"
        >
          <input
            id="eu-username"
            className={inputClass}
            aria-invalid={!!errors.username}
            autoComplete="off"
            value={username}
            readOnly={roleOnly}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field
          label="组"
          htmlFor="eu-group"
          error={errors.groupName}
          hint={roleOnly ? undefined : "留空表示不分组"}
        >
          <input
            id="eu-group"
            className={inputClass}
            aria-invalid={!!errors.groupName}
            value={groupName}
            readOnly={roleOnly}
            onChange={(e) => setGroupName(e.target.value)}
          />
        </Field>
        <Field
          label="角色"
          htmlFor="eu-role"
          error={errors.role}
          hint={isSelf ? "不能修改自己的角色" : undefined}
        >
          <RoleSelect
            id="eu-role"
            value={role}
            onChange={setRole}
            disabled={isSelf}
            roles={roleOnly ? ["member", "viewer"] : ROLES}
          />
        </Field>
        {!roleOnly && (
          <>
            <div className="col-span-2">
              <AccountChecklist
                ids={upstreamAccountIds}
                onChange={setUpstreamAccountIds}
                disabled={role === "admin"}
                hint={
                  role === "admin"
                    ? "管理员始终能看全部上游账号"
                    : "勾选该员工在桌面「用量窗口」里能看到的上游账号"
                }
              />
            </div>
            <Field
              label="重置密码"
              htmlFor="eu-password"
              error={errors.password}
              hint="留空则不修改；至少 6 位"
            >
              <input
                id="eu-password"
                type="password"
                autoComplete="new-password"
                className={inputClass}
                aria-invalid={!!errors.password}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field
              label="账号状态"
              htmlFor="eu-enabled"
              hint={isSelf ? "不能禁用自己" : disabled ? "已禁用" : "已启用"}
            >
              <div className="flex h-8 items-center">
                <Switch
                  id="eu-enabled"
                  label="启用账号"
                  checked={!disabled}
                  disabled={isSelf}
                  onChange={(on) => setDisabled(!on)}
                />
              </div>
            </Field>
          </>
        )}
        <div className="col-span-2">
          <InlineError>{formError}</InlineError>
        </div>
      </form>
    </Dialog>
  );
}

function AccountChecklist({
  ids,
  onChange,
  disabled,
  hint,
}: {
  ids: number[];
  onChange(ids: number[]): void;
  disabled?: boolean;
  hint?: string;
}) {
  const client = useApi();
  const accounts = useQuery({
    queryKey: ["admin", "upstream", "accounts"],
    queryFn: ({ signal }) =>
      client.request("/admin/upstream/accounts", {
        schema: UpstreamAccountsResponseSchema,
        signal,
      }),
  });
  const options = [
    ...(accounts.data?.items ?? []),
    ...(accounts.data?.codingPlanAvailable
      ? [
          {
            id: CODING_PLAN_ACCOUNT_ID,
            name: "火山方舟 Coding Plan",
            platform: "volcengine",
          },
        ]
      : []),
  ];
  return (
    <Field label="用量窗口" hint={hint}>
      {accounts.isPending ? (
        <p className="text-xs text-muted-foreground">正在加载账号列表…</p>
      ) : accounts.isError ? (
        <p className="text-xs text-muted-foreground">
          无法加载上游账号，稍后再试。
        </p>
      ) : options.length === 0 ? (
        <p className="text-xs text-muted-foreground">还没有上游账号。</p>
      ) : (
        <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
          {options.map((acc) => (
            <li key={acc.id}>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={disabled ? true : ids.includes(acc.id)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [...ids, acc.id]
                        : ids.filter((id) => id !== acc.id),
                    )
                  }
                />
                <span>{acc.name}</span>
                <span className="text-xs text-muted-foreground">
                  {acc.platform}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Field>
  );
}

function BulkWindowsDialog({
  users,
  onClose,
  onDone,
}: {
  users: User[];
  onClose(): void;
  onDone(): void;
}) {
  const client = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [ids, setIds] = useState<number[]>([]);
  const members = users.filter((u) => u.role !== "admin");
  const skipped = users.length - members.length;

  const apply = useMutation({
    mutationFn: async () => {
      let ok = 0;
      let lastError = "";
      for (const u of members) {
        try {
          await client.request(`/admin/users/${u.id}`, {
            method: "PATCH",
            body: { upstreamAccountIds: ids },
            schema: UserSchema,
          });
          ok += 1;
        } catch (err) {
          lastError = describeError(err);
        }
      }
      return { ok, fail: members.length - ok, lastError };
    },
    onSuccess: ({ ok, fail, lastError }) => {
      qc.invalidateQueries({ queryKey: USERS_KEY });
      if (ok > 0) toast.success(`已更新 ${ok} 个用户的用量窗口`);
      if (fail > 0) toast.error(`${fail} 个用户更新失败：${lastError}`);
      onDone();
    },
    onError: (err) => toast.error(`批量更新失败：${describeError(err)}`),
  });

  return (
    <Dialog
      open
      title="批量设置用量窗口"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            disabled={apply.isPending || members.length === 0}
            onClick={() => apply.mutate()}
          >
            {apply.isPending && <Spinner className="size-3" />}
            应用到 {members.length} 个用户
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted-foreground">
        将覆盖所选员工当前的用量窗口配置。管理员始终能看全部账号
        {skipped > 0 ? `，已跳过 ${skipped} 个管理员` : ""}。
      </p>
      <AccountChecklist
        ids={ids}
        onChange={setIds}
        hint="勾选这些用户能看到的上游账号；一个都不勾则他们打开用量窗口为空。"
      />
    </Dialog>
  );
}
