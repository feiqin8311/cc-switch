import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useSession } from "../lib/auth";
import { type TabItem, tabsFor } from "../nav";
import { NoPermission } from "./Layout";
import { PageHeader, Tabs } from "./ui";

/**
 * A page whose sections are tabs selected by `?tab=<id>`. Only the tabs the
 * session may see are shown; a missing or unknown tab falls back to the first
 * visible one. Tab bodies render their own description/actions row
 * (`PageHeader embedded`) under the tab bar.
 */
export function TabbedPage({
  title,
  description,
  tabs,
  bodies,
}: {
  title: string;
  description?: ReactNode;
  tabs: readonly TabItem[];
  bodies: Record<string, () => ReactNode>;
}) {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const visible = tabsFor(session.permissions, tabs);
  const requested = params.get("tab");
  const active = visible.find((t) => t.id === requested) ?? visible[0];

  if (!active) return <NoPermission>当前账号无权访问此页面。</NoPermission>;

  return (
    <div>
      <PageHeader title={title} description={description} />
      <Tabs
        label={title}
        tabs={visible}
        value={active.id}
        onChange={(id) => setParams({ tab: id })}
      />
      <div role="tabpanel" aria-label={active.label}>
        {bodies[active.id]?.()}
      </div>
    </div>
  );
}
