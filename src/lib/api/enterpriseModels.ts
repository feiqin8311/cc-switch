import { invoke } from "@tauri-apps/api/core";
import type { Provider } from "@/types";
import { extractCodexModelName } from "@/utils/providerConfigUtils";

export interface ProviderModelOption {
  id: string;
  displayName: string;
}

/** `meta.enterprise` of a Codex card managed by the enterprise server. */
export interface EnterpriseProviderMeta {
  serverUrl: string;
  providerId: string;
  models: ProviderModelOption[];
}

export function getEnterpriseMeta(
  provider: Provider,
): EnterpriseProviderMeta | undefined {
  const meta = provider.meta as
    | { enterprise?: EnterpriseProviderMeta | null }
    | undefined;
  return meta?.enterprise ?? undefined;
}

export function isEnterpriseManagedProvider(provider: Provider): boolean {
  return getEnterpriseMeta(provider) !== undefined;
}

/**
 * Models offered in the card's quick model switcher: the managed models of an
 * enterprise card, else the model catalog (`settingsConfig.modelCatalog.models`)
 * of a Codex card. Empty when the card has no known model list.
 */
export function getProviderModelOptions(
  provider: Provider,
): ProviderModelOption[] {
  const enterprise = getEnterpriseMeta(provider);
  if (enterprise) {
    return (enterprise.models ?? []).filter((m) => m.id);
  }
  const catalog = (
    provider.settingsConfig as {
      modelCatalog?: {
        models?: Array<{ model?: unknown; displayName?: unknown }>;
      };
    }
  )?.modelCatalog?.models;
  if (!Array.isArray(catalog)) return [];
  const seen = new Set<string>();
  const options: ProviderModelOption[] = [];
  for (const entry of catalog) {
    const id = typeof entry?.model === "string" ? entry.model.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName =
      typeof entry.displayName === "string" && entry.displayName.trim()
        ? entry.displayName.trim()
        : id;
    options.push({ id, displayName });
  }
  return options;
}

/** Top-level `model` of a Codex card's config.toml. */
export function getProviderCurrentModel(
  provider: Provider,
): string | undefined {
  const config = (provider.settingsConfig as { config?: unknown })?.config;
  return typeof config === "string" ? extractCodexModelName(config) : undefined;
}

export const enterpriseModelsApi = {
  /** Set the card's model; the live Codex config is re-applied when it is in use. */
  async setCodexProviderModel(
    providerId: string,
    model: string,
  ): Promise<boolean> {
    return await invoke<boolean>("codex_set_provider_model", {
      providerId,
      model,
    });
  },
};
