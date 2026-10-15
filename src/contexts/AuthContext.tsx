import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { enterpriseApi } from "@/lib/api/enterprise";
import type { EnterpriseState, Permission } from "@/types/enterprise";

/** Re-pull role / policies periodically so admin changes reach the client. */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

const SIGNED_OUT: EnterpriseState = {
  serverUrl: null,
  loggedIn: false,
  offline: false,
  user: null,
  permissions: [],
  config: null,
  lastError: null,
};

interface AuthContextValue {
  state: EnterpriseState;
  isLoading: boolean;
  login: (
    serverUrl: string,
    username: string,
    password: string,
  ) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Fails closed: false when signed out. Server still enforces every permission. */
  hasPermission: (permission: Permission) => boolean;
}

/** Desktop local cards. `providers.manage` is admin gateway CRUD and must not gate this. */
export function canManageLocalProviders(
  loggedIn: boolean,
  permissions: readonly Permission[],
): boolean {
  return !loggedIn || permissions.includes("models.use");
}

const noop = async () => {};

// Default value lets components render outside the provider (e.g. in tests).
const AuthContext = createContext<AuthContextValue>({
  state: SIGNED_OUT,
  isLoading: false,
  login: noop,
  logout: noop,
  refresh: noop,
  hasPermission: () => false,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<EnterpriseState>(SIGNED_OUT);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const current = await enterpriseApi.getState();
      setState(current);
      if (current.loggedIn) setState(await enterpriseApi.refreshConfig());
    } catch (err) {
      console.warn("[enterprise] refresh failed", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const login = useCallback(
    async (serverUrl: string, username: string, password: string) => {
      setState(await enterpriseApi.login(serverUrl, username, password));
    },
    [],
  );

  const logout = useCallback(async () => {
    setState(await enterpriseApi.logout());
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      isLoading,
      login,
      logout,
      refresh,
      hasPermission: (permission) =>
        state.loggedIn && state.permissions.includes(permission),
    }),
    [state, isLoading, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
