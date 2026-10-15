import {
  type CreateUserRequest,
  ListUsersResponseSchema,
  type Role,
  RoleSchema,
  type UpdateUserRequest,
  UpstreamAccountsResponseSchema,
  type User,
  UserSchema,
} from "@ccse/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Plus, Users as UsersIcon } from "lucide-react";
import { useToast } from "../components/Toast";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  InlineError,
  inputClass,
  LoadingState,
  PageHeader,
  Spinner,
  Switch,
  tableClass,
  tdClass,
  thClass,
  trClass,
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
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

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
  const users = useUsers();
  const client = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);

  const remove = useMutation({
    mutationFn: (user: User) =>
      client.request(`/admin/users/${user.id}`, { method: "DELETE" }),
    onSuccess: (_data, user) => {
      qc.invalidateQueries({ queryKey: USERS_KEY });
      toast.success(`已删除用户 ${user.username}`);
      setDeleting(null);
    },
    onError: (err) => toast.error(`删除失败：${describeError(err)}`),
  });

  return (
    <div>
      <PageHeader
        title="用户管理"
        description="创建员工账号、分配角色、重置密码、禁用或删除账号。禁用、改角色、重置密码或删除会立即注销该用户的所有会话。"
        actions={
          <div className="flex gap-2">
            <Button
              disabled={selected.length === 0}
              onClick={() => setBulkOpen(true)}
            >
              设置用量窗口
              {selected.length > 0 ? ` (${selected.length})` : ""}
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" />
              新建用户
            </Button>
          </div>
        }
      />
      <Card className="overflow-x-auto">
        {users.isPending ? (
          <LoadingState />
        ) : users.isError ? (
          <ErrorState error={users.error} onRetry={() => users.refetch()} />
        ) : users.data.items.length === 0 ? (
          <EmptyState
            icon={<UsersIcon className="size-6 stroke-[1.5]" />}
            title="暂无用户"
          >
            暂无用户
          </EmptyState>
        ) : (
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={`${thClass} w-8`}>
                  <input
                    type="checkbox"
                    aria-label="全选"
                    checked={
                      users.data.items.length > 0 &&
                      selected.length === users.data.items.length
                    }
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? users.data.items.map((u) => u.id)
                          : [],
                      )
                    }
                  />
                </th>
                <th className={thClass}>用户名</th>
                <th className={thClass}>显示名</th>
                <th className={thClass}>角色</th>
                <th className={thClass}>用量窗口</th>
                <th className={thClass}>状态</th>
                <th className={thClass}>创建时间</th>
                <th className={thClass}>最近登录</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {users.data.items.map((u) => (
                <tr key={u.id} className={trClass}>
                  <td className={tdClass}>
                    <input
                      type="checkbox"
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
                  <td className={`${tdClass} font-mono text-xs`}>
                    {u.username}
                    {u.id === session.user.id && (
                      <span className="ml-1.5 font-sans">
                        <Badge tone="blue">我</Badge>
                      </span>
                    )}
                  </td>
                  <td className={tdClass}>{u.displayName}</td>
                  <td className={tdClass}>
                    <Badge tone={u.role === "admin" ? "purple" : "gray"}>
                      {ROLE_LABELS[u.role]}
                    </Badge>
                  </td>
                  <td className={tdClass}>
                    {u.role === "admin"
                      ? "全部"
                      : u.upstreamAccountIds.length === 0
                        ? "无"
                        : `${u.upstreamAccountIds.length} 个账号`}
                  </td>
                  <td className={tdClass}>
                    {u.disabled ? (
                      <Badge tone="red">已禁用</Badge>
                    ) : (
                      <Badge tone="green">正常</Badge>
                    )}
                  </td>
                  <td className={`${tdClass} whitespace-nowrap`}>
                    {formatDateTime(u.createdAt)}
                  </td>
                  <td className={`${tdClass} whitespace-nowrap`}>
                    {formatDateTime(u.lastLoginAt)}
                  </td>
                  <td className={`${tdClass} text-right whitespace-nowrap`}>
                    <div className="inline-flex gap-1">
                      <Button size="sm" onClick={() => setEditing(u)}>
                        编辑
                      </Button>
                      {u.id !== session.user.id && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:bg-destructive/10"
                          onClick={() => setDeleting(u)}
                        >
                          删除
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {creating && <CreateUserDialog onClose={() => setCreating(false)} />}
      {bulkOpen && (
        <BulkWindowsDialog
          users={(users.data?.items ?? []).filter((u) =>
            selected.includes(u.id),
          )}
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
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="删除用户"
        danger
        confirmLabel="删除"
        pending={remove.isPending}
        message={
          <>
            确定删除 <b>{deleting?.username}</b>（{deleting?.displayName}
            ）吗？该账号会立即退出登录，其设备、用量和已留存的对话一并删除，此操作不可撤销。
          </>
        }
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}

function RoleSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: Role;
  onChange(role: Role): void;
  disabled?: boolean;
}) {
  return (
    <select
      id={id}
      className={inputClass}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as Role)}
    >
      {ROLES.map((r) => (
        <option key={r} value={r}>
          {ROLE_LABELS[r]}
        </option>
      ))}
    </select>
  );
}

function CreateUserDialog({ onClose }: { onClose(): void }) {
  const client = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<CreateUserRequest>({
    username: "",
    displayName: "",
    password: "",
    role: "member",
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
      next.username =
        "3-32 位，仅限小写字母、数字、'.'、'_'、'-'，且以字母或数字开头";
    if (!form.displayName.trim()) next.displayName = "请输入显示名";
    else if (form.displayName.trim().length > 64)
      next.displayName = "显示名最多 64 个字符";
    if (form.password.length < 10 || form.password.length > 128)
      next.password = "密码长度需为 10-128 位";
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0) return;
    create.mutate({
      ...form,
      username,
      displayName: form.displayName.trim(),
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
          hint="登录名，创建后不可修改"
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
          label="显示名"
          htmlFor="cu-display"
          required
          error={errors.displayName}
        >
          <input
            id="cu-display"
            className={inputClass}
            aria-invalid={!!errors.displayName}
            value={form.displayName}
            onChange={(e) => set("displayName", e.target.value)}
          />
        </Field>
        <Field
          label="初始密码"
          htmlFor="cu-password"
          required
          error={errors.password}
          hint="至少 10 位"
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
  onClose,
}: {
  user: User;
  isSelf: boolean;
  onClose(): void;
}) {
  const client = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const { patchCurrentUser } = useAuth();
  const [displayName, setDisplayName] = useState(user.displayName);
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
      const fields = fieldErrorsOf(err);
      if (Object.keys(fields).length > 0) setErrors(fields);
      else setFormError(describeError(err));
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    const name = displayName.trim();
    if (!name) next.displayName = "请输入显示名";
    else if (name.length > 64) next.displayName = "显示名最多 64 个字符";
    if (password && (password.length < 10 || password.length > 128))
      next.password = "密码长度需为 10-128 位";
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0) return;

    const body: UpdateUserRequest = {};
    if (name !== user.displayName) body.displayName = name;
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
          label="显示名"
          htmlFor="eu-display"
          required
          error={errors.displayName}
        >
          <input
            id="eu-display"
            className={inputClass}
            aria-invalid={!!errors.displayName}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
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
          />
        </Field>
        <div className="col-span-2">
          <AccountChecklist
            ids={upstreamAccountIds}
            onChange={setUpstreamAccountIds}
            disabled={user.role === "admin"}
            hint={
              user.role === "admin"
                ? "管理员始终能看全部上游账号"
                : "勾选该员工在桌面「用量窗口」里能看到的 Sub2API 账号"
            }
          />
        </div>
        <Field
          label="重置密码"
          htmlFor="eu-password"
          error={errors.password}
          hint="留空则不修改；至少 10 位"
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
  return (
    <Field label="用量窗口" hint={hint}>
      {accounts.isPending ? (
        <p className="text-xs text-muted-foreground">正在加载账号列表…</p>
      ) : accounts.isError || !accounts.data?.configured ? (
        <p className="text-xs text-muted-foreground">无法加载上游账号，稍后再试。</p>
      ) : accounts.data.items.length === 0 ? (
        <p className="text-xs text-muted-foreground">还没有上游账号。</p>
      ) : (
        <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
          {accounts.data.items.map((acc) => (
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
