import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { Layout, NoPermission } from "./components/Layout";
import { Button, LoadingState } from "./components/ui";
import { useAuth, useSession } from "./lib/auth";
import { describeError } from "./lib/format";
import { canAccess, NAV_ITEMS, navItemsFor } from "./nav";
import { ConversationsPage } from "./pages/ConversationsPage";
import { DeviceDetailPage } from "./pages/DeviceDetailPage";
import { DevicesPage } from "./pages/DevicesPage";
import { LoginPage } from "./pages/LoginPage";
import { MarketPage } from "./pages/MarketPage";
import { ProfilesPage } from "./pages/ProfilesPage";
import { ProvidersPage } from "./pages/ProvidersPage";
import { RetentionPage } from "./pages/RetentionPage";
import { UsagePage } from "./pages/UsagePage";
import { UsersPage } from "./pages/UsersPage";

function RequireAuth({ children }: { children: ReactNode }) {
  const { state, retry } = useAuth();
  const location = useLocation();
  switch (state.status) {
    case "loading":
      return <LoadingState label="正在恢复登录状态…" />;
    case "unavailable":
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-3">
          <p>无法连接服务器：{describeError(state.error)}</p>
          <Button onClick={retry}>重试</Button>
        </div>
      );
    case "anonymous":
      return (
        <Navigate
          to="/login"
          replace
          state={{ from: location.pathname + location.search }}
        />
      );
    case "authenticated":
      return children;
  }
}

/** Renders the page only when the session may see it. */
function Guard({ path, children }: { path: string; children: ReactNode }) {
  const session = useSession();
  const item = NAV_ITEMS.find((i) => i.path === path);
  if (item && !canAccess(session.permissions, item)) {
    return <NoPermission>当前账号无权访问此页面。</NoPermission>;
  }
  return children;
}

function Home() {
  const session = useSession();
  const first = navItemsFor(session.permissions)[0];
  return first ? <Navigate to={first.path} replace /> : <NoPermission />;
}

const PAGES: Record<string, () => ReactNode> = {
  "/users": () => <UsersPage />,
  "/providers": () => <ProvidersPage />,
  "/devices": () => <DevicesPage />,
  "/profiles": () => <ProfilesPage />,
  "/usage": () => <UsagePage />,
  "/conversations": () => <ConversationsPage />,
  "/retention": () => <RetentionPage />,
  "/market": () => <MarketPage />,
};

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Home />} />
        {Object.entries(PAGES).map(([path, render]) => (
          <Route
            key={path}
            path={path}
            element={<Guard path={path}>{render()}</Guard>}
          />
        ))}
        <Route
          path="/devices/:id"
          element={
            <Guard path="/devices">
              <DeviceDetailPage />
            </Guard>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
