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
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useAuth, useSession } from "../lib/auth";
import { ROLE_LABELS } from "../lib/format";
import { navItemsFor } from "../nav";
import { Badge, Button } from "./ui";

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
  const location = useLocation();
  const items = navItemsFor(session.permissions);

  const onLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  const activeItem = items.find((i) => i.path === location.pathname);

  return (
    <div className="flex h-screen min-w-[1024px] overflow-hidden bg-[#faf8f5] text-[#24221f] dark:bg-[#181715] dark:text-[#f5f3ed]">
      {/* Sidebar */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-[#eae6dd] bg-[#f5f3ed] dark:border-[#282622] dark:bg-[#151412]">
        {/* Brand */}
        <div className="flex h-16 items-center gap-2.5 px-5 border-b border-[#eae6dd]/70 dark:border-[#282622]/70">
          {/* Claude-inspired spark symbol */}
          <div className="flex size-7 items-center justify-center rounded-lg bg-[#c9643b] text-white shadow-2xs">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-4"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" fill="currentColor" />
              <path d="M12 2v3m0 14v3M2 12h3m14 0h3m-3.5-6.5-2.2 2.2m-8.6 8.6-2.2 2.2m0-13 2.2 2.2m8.6 8.6 2.2 2.2" />
            </svg>
          </div>
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="font-serif text-base font-normal tracking-tight text-[#24221f] dark:text-[#f5f3ed]">
              CC Switch
            </span>
            <span className="rounded-full bg-[#faece3] px-1.5 py-0.5 text-[9px] font-semibold tracking-wider text-[#c9643b] uppercase dark:bg-[#38231a] dark:text-[#e8906c]">
              Enterprise
            </span>
          </div>
        </div>

        {/* Navigation list */}
        <nav aria-label="主导航" className="flex flex-1 flex-col gap-1 p-3 overflow-y-auto">
          {items.map((item) => {
            const Icon = NAV_ICONS[item.path] ?? Users;
            return (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) =>
                  `group flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-all duration-150 ${
                    isActive
                      ? "bg-[#eae5db] text-[#1f1e1d] shadow-2xs dark:bg-[#272521] dark:text-[#f5f3ed]"
                      : "text-[#696459] hover:bg-[#f0ece2] hover:text-[#1f1e1d] dark:text-[#9e9a8f] dark:hover:bg-[#201f1c] dark:hover:text-[#f5f3ed]"
                  }`
                }
              >
                <Icon className="size-4 shrink-0 opacity-70 group-hover:opacity-100 transition-opacity" />
                <span className="truncate">{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        {/* User Card in Sidebar Bottom */}
        <div className="border-t border-[#eae6dd] p-3 dark:border-[#282622]">
          <div className="flex items-center gap-3 rounded-xl p-2 bg-[#f0ece3]/60 dark:bg-[#1e1d1a]/60">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#e4dfd4] text-xs font-semibold text-[#24221f] border border-[#d6cfc1] dark:bg-[#2a2824] dark:border-[#38352f] dark:text-[#f5f3ed]">
              {session.user.displayName.slice(0, 1) || "U"}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-xs font-medium text-[#24221f] dark:text-[#f5f3ed]">
                  {session.user.displayName}
                </span>
                <Badge tone="blue">
                  {ROLE_LABELS[session.user.role]}
                </Badge>
              </div>
              <p className="truncate text-[11px] text-[#8c877b] dark:text-[#8e8a7f]">
                @{session.user.username}
              </p>
            </div>
            <button
              type="button"
              onClick={onLogout}
              title="退出登录"
              aria-label="退出登录"
              className="flex size-7 items-center justify-center rounded-lg text-[#8c877b] hover:bg-[#e4dfd4] hover:text-[#24221f] transition-colors cursor-pointer dark:hover:bg-[#2a2824] dark:hover:text-[#f5f3ed]"
            >
              <LogOut className="size-3.5" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top Header */}
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-[#eae6dd] bg-[#faf8f5]/80 px-8 backdrop-blur-xs dark:border-[#282622] dark:bg-[#181715]/80">
          <div className="flex items-center gap-2 text-xs text-[#7c776c] dark:text-[#9e9a8f]">
            <span>CC Switch Enterprise</span>
            {activeItem && (
              <>
                <span>/</span>
                <span className="font-medium text-[#24221f] dark:text-[#f5f3ed]">
                  {activeItem.label}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-[#7c776c] dark:text-[#9e9a8f]">
              <span className="font-medium text-[#24221f] dark:text-[#f5f3ed]">
                {session.user.displayName}
              </span>
              <span className="ml-1 text-[#8c877b]">({session.user.username})</span>
            </span>
            <Button size="sm" variant="secondary" onClick={onLogout}>
              <LogOut className="size-3 text-[#7c776c]" />
              退出登录
            </Button>
          </div>
        </header>

        {/* Scrollable page body */}
        <main className="min-h-0 flex-1 overflow-auto p-6 md:p-8">
          <div className="mx-auto max-w-[1240px]">
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
      <p className="font-serif text-lg font-medium text-[#24221f] dark:text-[#f5f3ed]">
        无管理权限
      </p>
      <p className="text-sm text-[#7c776c] dark:text-[#9e9a8f] max-w-md">
        {children ??
          "当前账号没有任何管理权限，请联系管理员分配角色。普通成员请在 CC Switch 客户端中使用企业功能。"}
      </p>
    </div>
  );
}
