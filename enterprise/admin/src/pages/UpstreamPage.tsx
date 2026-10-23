import {
  CodingPlanUsageResponseSchema,
  UpstreamAccountsResponseSchema,
} from "@ccse/contracts";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { CodingPlanUsageCard } from "../components/CodingPlanUsageCard";
import { UpstreamAccountCard } from "../components/UpstreamAccountCard";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from "../components/ui";
import { useApi } from "../lib/auth";

export function UpstreamPage() {
  const client = useApi();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const q = useQuery({
    queryKey: ["admin", "upstream", "accounts"],
    queryFn: ({ signal }) =>
      client.request("/admin/upstream/accounts", {
        schema: UpstreamAccountsResponseSchema,
        signal,
      }),
    refetchInterval: 60_000,
  });
  const canSeeCodingPlan = q.data?.codingPlanAvailable === true;
  const codingPlan = useQuery({
    queryKey: ["admin", "coding-plan"],
    queryFn: ({ signal }) =>
      client.request("/admin/usage/coding-plan", {
        schema: CodingPlanUsageResponseSchema,
        signal,
      }),
    refetchInterval: 60_000,
    enabled: canSeeCodingPlan,
  });
  const accounts = q.data?.items ?? [];
  const hasCodingPlan = canSeeCodingPlan && !!codingPlan.data?.configured;
  const loading = q.isPending || (canSeeCodingPlan && codingPlan.isPending);
  const fetching = q.isFetching || (canSeeCodingPlan && codingPlan.isFetching);
  const hasCards = accounts.length > 0 || hasCodingPlan;
  return (
    <div className="space-y-6">
      <PageHeader
        title="上游账号"
        description="查看 Sub2API 与火山方舟等上游账号的套餐用量和重置时间。"
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              void q.refetch();
              if (canSeeCodingPlan) void codingPlan.refetch();
            }}
            disabled={fetching}
          >
            <RefreshCw
              className={`size-3.5 ${fetching ? "animate-spin" : ""}`}
            />
            刷新
          </Button>
        }
      />
      {loading && <LoadingState label="正在读取上游账号…" />}
      {q.isError && (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      )}
      {canSeeCodingPlan && codingPlan.isError && !codingPlan.data && (
        <ErrorState
          error={codingPlan.error}
          onRetry={() => void codingPlan.refetch()}
        />
      )}
      {hasCards && (
        <div className="grid gap-4 md:grid-cols-2">
          {accounts.map((acc) => (
            <UpstreamAccountCard key={acc.id} acc={acc} />
          ))}
          {hasCodingPlan && codingPlan.data && (
            <CodingPlanUsageCard
              data={codingPlan.data}
              now={now}
              refreshFailed={codingPlan.isError}
            />
          )}
        </div>
      )}
      {q.data?.configured && q.data.error && (
        <Card>
          <p role="alert" className="text-sm text-destructive">
            Sub2API：{q.data.error}
          </p>
        </Card>
      )}
      {!loading &&
        !hasCards &&
        !q.isError &&
        !(canSeeCodingPlan && codingPlan.isError) && (
          <EmptyState title="暂无上游账号">
            {q.data?.configured
              ? "当前没有可查看的上游账号，请联系管理员分配账号或检查上游配置。"
              : "尚未连接上游账号，请在企业服务端配置 Sub2API 或火山方舟。"}
          </EmptyState>
        )}
    </div>
  );
}
