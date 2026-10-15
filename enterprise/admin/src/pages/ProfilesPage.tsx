import {
  AdminProfileSchema,
  ListProfilesResponseSchema,
} from "@ccse/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { useToast } from "../components/Toast";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  tableClass,
  tdClass,
  thClass,
  trClass,
} from "../components/ui";
import { useApi } from "../lib/auth";
import { describeError } from "../lib/format";
import { FleetForm } from "./DevicesPage";

const PROFILES_KEY = ["admin", "profiles"] as const;

const MODE_LABEL = { direct: "直连", route: "路由", stack: "聚合" } as const;

export function ProfilesPage({ embedded }: { embedded?: boolean } = {}) {
  const client = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [openId, setOpenId] = useState<string | null>(null);
  const profiles = useQuery({
    queryKey: PROFILES_KEY,
    queryFn: ({ signal }) =>
      client.get("/admin/profiles", ListProfilesResponseSchema, signal),
  });
  const create = useMutation({
    mutationFn: () =>
      client.request("/admin/profiles", {
        method: "POST",
        body: {
          name: "新方案",
          mode: "direct",
          activeProviderId: "",
          stackMemberIds: [],
          providers: [],
        },
        schema: AdminProfileSchema,
      }),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: PROFILES_KEY });
      setOpenId(saved.id);
      toast.success("已新建方案");
    },
    onError: (err) => toast.error(describeError(err)),
  });

  return (
    <div>
      <PageHeader
        embedded={embedded}
        title="配置方案"
        description="每套方案可以单独分给电脑。没指定的电脑使用默认方案。"
        actions={
          <Button
            variant="primary"
            onClick={() => create.mutate()}
            disabled={create.isPending}
          >
            <Plus className="size-4" />
            新建方案
          </Button>
        }
      />
      <Card className="overflow-x-auto">
        {profiles.isPending ? (
          <LoadingState />
        ) : profiles.isError ? (
          <ErrorState
            error={profiles.error}
            onRetry={() => profiles.refetch()}
          />
        ) : profiles.data.items.length === 0 ? (
          <EmptyState title="还没有配置方案">保存后会出现在这里。</EmptyState>
        ) : (
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>名称</th>
                <th className={thClass}>模式</th>
                <th className={thClass}>供应商</th>
                <th className={thClass}>电脑</th>
                <th className={thClass}>版本</th>
              </tr>
            </thead>
            <tbody>
              {profiles.data.items.map((item) => (
                <tr key={item.id} className={trClass}>
                  <td className={tdClass}>
                    <button
                      type="button"
                      className="underline"
                      onClick={() =>
                        setOpenId(openId === item.id ? null : item.id)
                      }
                    >
                      {item.name}
                    </button>
                    {item.isDefault && <Badge tone="blue">默认</Badge>}
                  </td>
                  <td className={tdClass}>{MODE_LABEL[item.mode]}</td>
                  <td className={tdClass}>{item.providerCount}</td>
                  <td className={tdClass}>{item.deviceCount}</td>
                  <td className={tdClass}>{item.revision}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {openId && <ProfileEditor id={openId} />}
      <p className="mt-4 text-xs text-muted-foreground">
        电脑列表在{" "}
        <Link className="underline" to="/devices?tab=devices">
          设备
        </Link>
        标签页。
      </p>
    </div>
  );
}

function ProfileEditor({ id }: { id: string }) {
  const client = useApi();
  const profile = useQuery({
    queryKey: ["admin", "profile", id],
    queryFn: ({ signal }) =>
      client.get(`/admin/profiles/${id}`, AdminProfileSchema, signal),
  });
  if (profile.isPending) return <LoadingState />;
  if (profile.isError) {
    return (
      <ErrorState error={profile.error} onRetry={() => profile.refetch()} />
    );
  }
  return (
    <Card className="mt-6 p-6">
      <FleetForm
        key={`${profile.data.id}-${profile.data.revision}`}
        initial={profile.data}
        profile={{
          id: profile.data.id,
          name: profile.data.name,
          isDefault: profile.data.isDefault,
        }}
      />
    </Card>
  );
}
