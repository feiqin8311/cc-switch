import {
  type CreateUserRequest,
  ListUsersResponseSchema,
  type Role,
  RoleSchema,
  type UpdateUserRequest,
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
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);

  return (
    <div>
      <PageHeader
        title="用户管理"
        description="创建员工账号、分配角色、重置密码或禁用账号。禁用、改角色或重置密码会立即注销该用户的所有会话。"
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            新建用户
          </Button>
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
                <th className={thClass}>用户名</th>
                <th className={thClass}>显示名</th>
                <th className={thClass}>角色</th>
                <th className={thClass}>状态</th>
                <th className={thClass}>创建时间</th>
                <th className={thClass}>最近登录</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {users.data.items.map((u) => (
                <tr key={u.id} className={trClass}>
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
                  <td className={`${tdClass} text-right`}>
                    <Button size="sm" onClick={() => setEditing(u)}>
                      编辑
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {creating && <CreateUserDialog onClose={() => setCreating(false)} />}
      {editing && (
        <EditUserDialog
          key={editing.id}
          user={editing}
          isSelf={editing.id === session.user.id}
          onClose={() => setEditing(null)}
        />
      )}
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
