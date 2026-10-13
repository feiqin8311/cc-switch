import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Provider } from "@/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  enterpriseModelsApi,
  getProviderCurrentModel,
  getProviderModelOptions,
  isEnterpriseManagedProvider,
} from "@/lib/api/enterpriseModels";
import { toast } from "@/lib/toast";

interface ProviderModelSelectProps {
  provider: Provider;
}

/**
 * Compact model switcher on a Codex provider card. Enterprise-managed cards
 * list the models the server offers (even a single one, for information);
 * other cards need a model catalog with at least two models.
 */
export function ProviderModelSelect({ provider }: ProviderModelSelectProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isEnterprise = isEnterpriseManagedProvider(provider);
  const options = useMemo(() => getProviderModelOptions(provider), [provider]);
  const currentModel = getProviderCurrentModel(provider);

  const mutation = useMutation({
    mutationFn: (model: string) =>
      enterpriseModelsApi.setCodexProviderModel(provider.id, model),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
    },
    onError: (error) => {
      toast.error(
        t("enterpriseModels.changeFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  });

  if (options.length < (isEnterprise ? 1 : 2)) {
    return null;
  }

  // The configured model may no longer be listed; keep it visible.
  const items =
    currentModel && !options.some((o) => o.id === currentModel)
      ? [{ id: currentModel, displayName: currentModel }, ...options]
      : options;
  const label = t("enterpriseModels.selectLabel", { name: provider.name });

  return (
    <Select
      value={currentModel ?? ""}
      onValueChange={(model) => {
        if (model && model !== currentModel) {
          mutation.mutate(model);
        }
      }}
      disabled={mutation.isPending}
    >
      <SelectTrigger
        className="h-7 w-auto max-w-[160px] gap-1 px-2 text-caption"
        aria-label={label}
        title={label}
        onClick={(e) => e.stopPropagation()}
      >
        <SelectValue placeholder={t("enterpriseModels.placeholder")} />
      </SelectTrigger>
      <SelectContent align="end">
        {items.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.displayName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
