import type { ReactNode } from "react";
import {
  BarChart3,
  Cpu,
  LogOut,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { useAuth, useSession } from "../lib/auth";
import { ROLE_LABELS } from "../lib/format";
import { navItemsFor } from "../nav";
import { BrandMark } from "./BrandMark";

const NAV_ICONS: Record<string, typeof Users> = {
  "/users": Users,
  "/providers": Cpu,
  "/usage": BarChart3,
  "/conversations": MessageSquareText,
  "/retention": ShieldCheck,
  "/market": Sparkles,
};

export function Layout() {
  const session = useSession();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const items = navItemsFor(session.permissions);

  const onLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  return (
    <div className="flex h-screen min-w-[1024px] overflow-hidden bg-background text-foreground">
      {/* Sidebar (exact match to claude-front sidebar) */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        {/* Top Header / Traffic Lights & Brand */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-sidebar-border/60 px-3">
          {/* macOS Traffic Lights */}
          <div className="flex items-center gap-1.5 mr-1.5">
            <div className="size-3 rounded-full bg-[#ff5f57]" />
            <div className="size-3 rounded-full bg-[#febc2e]" />
            <div className="size-3 rounded-full bg-[#28c840]" />
          </div>

          <BrandMark className="size-4.5 text-brand" />
          <span className="font-serif text-sm font-medium tracking-tight text-foreground">
            CC Switch
          </span>
          <span className="rounded-full bg-brand/10 px-1.5 py-0.2 text-[9px] font-medium text-brand">
            Enterprise
          </span>
        </div>

        {/* Navigation list */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-3">
          <div className="px-2 pb-1.5 text-[11px] font-medium text-muted-foreground tracking-tight">
            管理菜单
          </div>
          <nav aria-label="主导航" className="flex flex-col gap-0.5">
            {items.map((item) => {
              const Icon = NAV_ICONS[item.path] ?? Users;
              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={({ isActive }) =>
                    `flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm transition-colors cursor-pointer ${
                      isActive
                        ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                        : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
                    }`
                  }
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{item.label}</span>
                </NavLink>
              );
            })}
          </nav>
        </div>

        {/* User Card in Sidebar Bottom (exact match to claude-front line 682) */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-t border-sidebar-border px-3">
          <div
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left"
            aria-label={`Account menu for ${session.user.displayName}`}
          >
            <span
              aria-hidden="true"
              className="flex size-5 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-[10px] font-medium text-sidebar-foreground"
            >
              {session.user.displayName.slice(0, 1) || "U"}
            </span>
            <div className="min-w-0 flex-1 truncate">
              <span className="truncate text-xs font-medium text-sidebar-foreground">
                {session.user.displayName}
                <span className="text-[11px] text-muted-foreground font-normal">
                  {" · "}
                  {ROLE_LABELS[session.user.role]}
                </span>
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onLogout}
            title="退出登录"
            aria-label="退出登录"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground cursor-pointer"
          >
            <LogOut className="size-3.5" />
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <main className="min-h-0 flex-1 overflow-y-auto px-6 py-8 md:px-10 md:py-10">
          <div className="mx-auto max-w-4xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

export function NoPermission({ children }: { children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-24 text-center">
      <BrandMark className="size-8 text-brand mb-2" />
      <p className="font-serif text-lg font-normal text-foreground">
        无管理权限
      </p>
      <p className="text-xs text-muted-foreground max-w-md">
        {children ??
          "当前账号没有任何管理权限，请联系管理员分配角色。普通成员请在 CC Switch 客户端中使用企业功能。"}
      </p>
    </div>
  );
}
