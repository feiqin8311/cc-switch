import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  OfflineAccountCostInputSchema,
  type OfflineAccountCost,
} from "@ccse/contracts";
import { Plus, Trash2 } from "lucide-react";
import {
  Button,
  Dialog,
  ConfirmDialog,
  Field,
  InlineError,
  inputClass,
  Select,
  Spinner,
} from "../components/ui";
import { useApi } from "../lib/auth";
import { describeError } from "../lib/format";

type Draft = {
  id: number | null;
  name: string;
  department: string;
  charges: { month: string; amount: string }[];
};

export function OfflineAccountCostsDialog({
  accounts,
  departments,
  defaultMonth,
  onSaved,
  onClose,
}: {
  accounts: OfflineAccountCost[];
  departments: string[];
  defaultMonth: string;
  onSaved(): Promise<unknown>;
  onClose(): void;
}) {
  const client = useApi();
  const currentMonth = new Date()
    .toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
    .slice(0, 7);
  const newDraft = (): Draft => ({
    id: null,
    name: "",
    department: departments[0] ?? "",
    charges: [{ month: defaultMonth, amount: "" }],
  });
  const [draft, setDraft] = useState<Draft>(newDraft);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const months = [
    ...new Set([
      ...Array.from({ length: 120 }, (_, index) => {
        const date = new Date(
          Date.UTC(
            Number(currentMonth.slice(0, 4)),
            Number(currentMonth.slice(5, 7)) - 1 - index,
            15,
          ),
        );
        return date.toISOString().slice(0, 7);
      }),
      ...draft.charges.map((charge) => charge.month),
    ]),
  ]
    .sort()
    .reverse();
  const save = useMutation({
    mutationFn: async () => {
      if (draft.charges.some((charge) => !charge.amount.trim()))
        throw new Error("请填写每条入账记录的金额");
      const body = OfflineAccountCostInputSchema.parse({
        name: draft.name,
        department: draft.department,
        charges: draft.charges.map((charge) => ({
          month: charge.month,
          monthlyUsd: Number(charge.amount),
        })),
      });
      await client.request(
        `/admin/usage/account-costs/accounts${draft.id === null ? "" : `/${draft.id}`}`,
        {
          method: draft.id === null ? "POST" : "PUT",
          body,
        },
      );
    },
    onSuccess: async () => {
      await onSaved();
      onClose();
    },
    onError: (err) => setError(describeError(err)),
  });
  const remove = useMutation({
    mutationFn: async (target: { id: number; name: string }) => {
      await client.request(`/admin/usage/account-costs/accounts/${target.id}`, {
        method: "DELETE",
      });
    },
    onSuccess: async () => {
      setDeleteTarget(null);
      await onSaved();
      onClose();
    },
    onError: (err) => setError(describeError(err)),
  });
  const busy = save.isPending || remove.isPending;
  const close = () => {
    if (!busy && !deleteTarget) onClose();
  };
  const choose = (account: OfflineAccountCost | null) => {
    if (busy || deleteTarget) return;
    setError(null);
    setDraft(
      account
        ? {
            id: account.id,
            name: account.name,
            department: account.department,
            charges: account.charges.map((charge) => ({
              month: charge.month,
              amount: String(charge.monthlyUsd),
            })),
          }
        : newDraft(),
    );
  };
  const availableMonth = months.find(
    (month) => !draft.charges.some((charge) => charge.month === month),
  );
  return (
    <>
      <Dialog
        open
        title="编辑账户"
        width="max-w-3xl"
        onClose={close}
        footer={
          <>
            {draft.id !== null && (
              <div className="mr-auto">
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    if (draft.id === null) return;
                    setError(null);
                    setDeleteTarget({
                      id: draft.id,
                      name:
                        accounts.find((account) => account.id === draft.id)
                          ?.name ?? draft.name,
                    });
                  }}
                >
                  <Trash2 className="size-3.5" />
                  删除账户
                </Button>
              </div>
            )}
            <Button onClick={close} disabled={busy}>
              取消
            </Button>
            <Button
              type="submit"
              form="offline-account-costs"
              variant="primary"
              disabled={busy}
            >
              {busy && <Spinner className="size-3" />}保存账户
            </Button>
          </>
        }
      >
        <p className="mb-4 text-xs leading-5 text-muted-foreground">
          手动添加未接入上游的账号，按所选月份记录费用，可修改或删除已填写的记录。
        </p>
        <div className="grid gap-5 sm:grid-cols-[11rem_minmax(0,1fr)]">
          <div className="flex flex-col gap-1 sm:border-r sm:border-border/50 sm:pr-4">
            <Button
              onClick={() => choose(null)}
              disabled={busy}
              variant={draft.id === null ? "primary" : "ghost"}
            >
              <Plus className="size-3.5" />
              新增账号
            </Button>
            <div className="mt-2 max-h-80 space-y-1 overflow-y-auto">
              {accounts.map((account) => (
                <button
                  key={account.id}
                  type="button"
                  disabled={busy}
                  onClick={() => choose(account)}
                  aria-pressed={draft.id === account.id}
                  className={`w-full rounded-lg px-3 py-2 text-left text-xs ${draft.id === account.id ? "bg-muted" : "hover:bg-muted/50"}`}
                >
                  <span className="block truncate font-medium">
                    {account.name}
                  </span>
                  <span className="mt-1 block truncate text-[10px] text-muted-foreground">
                    {account.department} · {account.charges.length} 个月
                  </span>
                </button>
              ))}
              {!accounts.length && (
                <p className="px-2 py-3 text-[11px] text-muted-foreground">
                  暂无手动账号
                </p>
              )}
            </div>
          </div>
          <form
            id="offline-account-costs"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || deleteTarget) return;
              setError(null);
              save.mutate();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="账号名称" htmlFor="offline-account-name">
                <input
                  id="offline-account-name"
                  className={inputClass}
                  required
                  maxLength={200}
                  value={draft.name}
                  placeholder="例如：设计组 GPT"
                  disabled={busy}
                  onChange={(event) =>
                    setDraft((value) => ({
                      ...value,
                      name: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label="所属部门" htmlFor="offline-account-department">
                <Select
                  id="offline-account-department"
                  aria-label="手动账号所属部门"
                  value={draft.department}
                  disabled={busy}
                  options={[...new Set([...departments, draft.department])]
                    .filter(Boolean)
                    .map((department) => ({
                      value: department,
                      label: department,
                    }))}
                  onChange={(department) =>
                    setDraft((value) => ({ ...value, department }))
                  }
                />
              </Field>
            </div>
            <div className="mt-5 flex items-center justify-between">
              <h3 className="text-xs font-medium">入账记录</h3>
              <Button
                size="sm"
                variant="ghost"
                disabled={
                  busy || !availableMonth || draft.charges.length >= 600
                }
                onClick={() =>
                  availableMonth &&
                  setDraft((value) => ({
                    ...value,
                    charges: [
                      ...value.charges,
                      {
                        month: availableMonth,
                        amount: value.charges.at(-1)?.amount ?? "",
                      },
                    ],
                  }))
                }
              >
                <Plus className="size-3" />
                新增入账月份
              </Button>
            </div>
            <div className="mt-2 max-h-72 space-y-3 overflow-y-auto pr-1">
              {draft.charges.map((charge, index) => (
                <div
                  key={index}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.5rem] items-end gap-2 rounded-lg border border-border/60 p-3"
                >
                  <Field
                    label="入账月份"
                    htmlFor={`offline-charge-month-${index}`}
                  >
                    <Select
                      id={`offline-charge-month-${index}`}
                      aria-label={`入账月份 ${index + 1}`}
                      value={charge.month}
                      disabled={busy}
                      options={months
                        .filter(
                          (month) =>
                            month === charge.month ||
                            !draft.charges.some(
                              (entry) => entry.month === month,
                            ),
                        )
                        .map((month) => ({
                          value: month,
                          label: `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`,
                        }))}
                      onChange={(month) =>
                        setDraft((value) => ({
                          ...value,
                          charges: value.charges.map((entry, i) =>
                            i === index ? { ...entry, month } : entry,
                          ),
                        }))
                      }
                    />
                  </Field>
                  <Field
                    label="费用（USD）"
                    htmlFor={`offline-charge-amount-${index}`}
                  >
                    <input
                      id={`offline-charge-amount-${index}`}
                      className={inputClass}
                      type="number"
                      min="0"
                      max="1000000"
                      step="0.01"
                      required
                      value={charge.amount}
                      disabled={busy}
                      onChange={(event) =>
                        setDraft((value) => ({
                          ...value,
                          charges: value.charges.map((entry, i) =>
                            i === index
                              ? { ...entry, amount: event.target.value }
                              : entry,
                          ),
                        }))
                      }
                    />
                  </Field>
                  {draft.charges.length > 1 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`移除入账月份 ${index + 1}`}
                      onClick={() =>
                        setDraft((value) => ({
                          ...value,
                          charges: value.charges.filter((_, i) => i !== index),
                        }))
                      }
                    >
                      移除
                    </Button>
                  ) : (
                    <span />
                  )}
                </div>
              ))}
            </div>
            <InlineError>{error}</InlineError>
          </form>
        </div>
      </Dialog>
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除账户"
        message={
          <>
            <p>
              确定删除“{deleteTarget?.name}
              ”吗？该手动账号及所有手动入账费用将一并删除，统计金额随之更新。
            </p>
            <InlineError>{error}</InlineError>
          </>
        }
        confirmLabel="确认删除"
        danger
        pending={remove.isPending}
        onConfirm={() => deleteTarget && !busy && remove.mutate(deleteTarget)}
        onCancel={() => {
          if (!busy) {
            setDeleteTarget(null);
            setError(null);
          }
        }}
      />
    </>
  );
}
