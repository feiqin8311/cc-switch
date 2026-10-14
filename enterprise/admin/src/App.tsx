import type { Permission } from "@ccse/contracts";
import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { Layout, NoPermission } from "./components/Layout";
import { TabbedPage } from "./components/TabbedPage";
import { Button, LoadingState } from "./components/ui";
import { useAuth, useSession } from "./lib/auth";
import { describeError } from "./lib/format";
import {
  CONVERSATION_TABS,
  canAccess,
  DEVICE_TABS,
  NAV_ITEMS,
  navItemsFor,
} from "./nav";
import { ConversationsPage } from "./pages/ConversationsPage";
import { DeviceDetailPage } from "./pages/DeviceDetailPage";
import { DevicesPage } from "./pages/DevicesPage";
import { LoginPage } from "./pages/LoginPage";
import { MARKET_PAGES, MarketPage } from "./pages/MarketPage";
import { ProfilesPage } from "./pages/ProfilesPage";
import { ProvidersPage } from "./pages/ProvidersPage";
import { RetentionPage } from "./pages/RetentionPage";
import { UpstreamPage } from "./pages/UpstreamPage";
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

/**
 * Renders the page only when the session may see it: by the nav item of
 * `path`, or by `anyOf` for routes without one of their own.
 */
function Guard({
  path,
  anyOf,
  children,
}: {
  path?: string;
  anyOf?: readonly Permission[];
  children: ReactNode;
}) {
  const session = useSession();
  const item = anyOf ? { anyOf } : NAV_ITEMS.find((i) => i.path === path);
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
  "/devices": () => (
    <TabbedPage
      title="设备管理"
      tabs={DEVICE_TABS}
      bodies={{
        devices: () => <DevicesPage embedded />,
        profiles: () => <ProfilesPage embedded />,
        providers: () => <ProvidersPage embedded />,
      }}
    />
  ),
  "/usage": () => <UsagePage />,
  "/upstream": () => <UpstreamPage />,
  "/mcp": () => <MarketPage key="mcp" {...MARKET_PAGES.mcp} />,
  "/skills": () => <MarketPage key="skills" {...MARKET_PAGES.skills} />,
  "/prompts": () => <MarketPage key="prompts" {...MARKET_PAGES.prompts} />,
  "/conversations": () => (
    <TabbedPage
      title="会话"
      tabs={CONVERSATION_TABS}
      bodies={{
        records: () => <ConversationsPage embedded />,
        retention: () => <RetentionPage embedded />,
      }}
    />
  ),
};

/** Pages that moved into tabs (or were split); old links keep working. */
const REDIRECTS: Record<string, string> = {
  "/providers": "/devices?tab=providers",
  "/profiles": "/devices?tab=profiles",
  "/retention": "/conversations?tab=retention",
  "/market": "/skills",
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
        {Object.entries(REDIRECTS).map(([from, to]) => (
          <Route
            key={from}
            path={from}
            element={<Navigate to={to} replace />}
          />
        ))}
        <Route
          path="/devices/:id"
          element={
            // The device list is the settings.manage tab of 设备管理.
            <Guard anyOf={["settings.manage"]}>
              <DeviceDetailPage />
            </Guard>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
