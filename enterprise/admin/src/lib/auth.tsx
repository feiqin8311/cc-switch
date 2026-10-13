import type { Permission, User } from "@ccse/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ApiClient, SessionInfo } from "./api";

export type AuthState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; session: SessionInfo }
  /** The stored session could not be checked (server unreachable / 5xx). */
  | { status: "unavailable"; error: unknown };

interface AuthContextValue {
  state: AuthState;
  client: ApiClient;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  /** Re-attempts restoring the stored session after `unavailable`. */
  retry(): void;
  /** Keeps the header in sync after the current user edits their own record. */
  patchCurrentUser(user: User): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const DEVICE_NAME = "管理后台 (Web)";

export function AuthProvider({
  client,
  children,
}: {
  client: ApiClient;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>(() =>
    client.hasStoredSession() ? { status: "loading" } : { status: "anonymous" },
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(
    () =>
      client.onSessionChange((session) => {
        if (session) {
          setState({ status: "authenticated", session });
        } else {
          queryClient.clear();
          setState({ status: "anonymous" });
        }
      }),
    [client, queryClient],
  );

  // `attempt` is a dependency on purpose: bumping it re-runs the restore.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!client.hasStoredSession()) return;
    let cancelled = false;
    setState({ status: "loading" });
    client.restore().then(
      (session) => {
        if (cancelled) return;
        setState(
          session
            ? { status: "authenticated", session }
            : { status: "anonymous" },
        );
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: "unavailable", error });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, attempt]);

  const login = useCallback(
    async (username: string, password: string) => {
      await client.login({ username, password, deviceName: DEVICE_NAME });
    },
    [client],
  );

  const logout = useCallback(() => client.logout(), [client]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const patchCurrentUser = useCallback((user: User) => {
    setState((s) =>
      s.status === "authenticated" && s.session.user.id === user.id
        ? { status: "authenticated", session: { ...s.session, user } }
        : s,
    );
  }, []);

  const value = useMemo(
    () => ({ state, client, login, logout, retry, patchCurrentUser }),
    [state, client, login, logout, retry, patchCurrentUser],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** The authenticated session; only call below a route that requires login. */
export function useSession(): SessionInfo {
  const { state } = useAuth();
  if (state.status !== "authenticated") {
    throw new Error("useSession requires an authenticated session");
  }
  return state.session;
}

export function hasPermission(session: SessionInfo, p: Permission): boolean {
  return session.permissions.includes(p);
}

/** The API client of the current session. */
export function useApi(): ApiClient {
  return useAuth().client;
}

/** Whether the signed-in user has a permission (UI only; the server enforces). */
export function useCan(p: Permission): boolean {
  const { state } = useAuth();
  return state.status === "authenticated" && hasPermission(state.session, p);
}
