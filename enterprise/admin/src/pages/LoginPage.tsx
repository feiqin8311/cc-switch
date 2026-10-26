import { type FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { BrandMark } from "../components/BrandMark";
import {
  Button,
  Field,
  InlineError,
  inputClass,
  Spinner,
} from "../components/ui";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { describeError } from "../lib/format";

function loginErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "unauthorized") return "用户名或密码错误，或账号已被禁用";
    if (err.code === "rate_limited") return "登录失败次数过多，请稍后再试";
  }
  return describeError(err);
}

export function LoginPage() {
  const { state, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const requested = (location.state as { from?: string } | null)?.from;
  const from =
    requested?.startsWith("/") &&
    !requested.startsWith("//") &&
    !requested.startsWith("/login")
      ? requested
      : "/";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (state.status === "authenticated") return <Navigate to={from} replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError("请输入用户名和密码");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await login(username.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(loginErrorMessage(err));
      setPassword("");
      setPending(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-4 bg-background">
      <div className="w-full max-w-md rounded-2xl border border-border/80 bg-card p-8 shadow-sm">
        {/* Brand header */}
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3.5 flex size-10 items-center justify-center rounded-xl bg-brand/10 text-brand shadow-xs">
            <BrandMark className="size-6 text-brand" />
          </div>
          <h1 className="font-serif text-2xl font-normal tracking-tight text-foreground">
            CC Switch Enterprise
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            企业管理控制台登录
          </p>
        </div>

        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <Field label="用户名" htmlFor="login-username">
            <input
              id="login-username"
              className={inputClass}
              autoComplete="username"
              placeholder="请输入管理员或员工用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field label="密码" htmlFor="login-password">
            <input
              id="login-password"
              type="password"
              className={inputClass}
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {error && <InlineError>{error}</InlineError>}
          <Button
            type="submit"
            variant="primary"
            disabled={pending}
            className="w-full mt-2 h-9"
          >
            {pending && <Spinner className="size-3" />}
            登录
          </Button>
        </form>
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        CC Switch Enterprise · Codex-Only Edition
      </p>
    </div>
  );
}
