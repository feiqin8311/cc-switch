import { getVersion } from "@tauri-apps/api/app";

export type UpdateChannel = "stable" | "beta";

export interface UpdateInfo {
  currentVersion: string;
  availableVersion: string;
  notes?: string;
  pubDate?: string;
}

export interface CheckOptions {
  timeout?: number;
  channel?: UpdateChannel;
}

export async function getCurrentVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "";
  }
}

interface AppUpdatePayload {
  availableVersion: string;
  notes?: string | null;
  pubDate?: string | null;
}

export async function checkForUpdate(
  _opts: CheckOptions = {},
): Promise<
  { status: "up-to-date" } | { status: "available"; info: UpdateInfo }
> {
  // 走 Rust：清单地址是已登录的企业服务器，不走官方源。
  const { invoke } = await import("@tauri-apps/api/core");
  const currentVersion = await getCurrentVersion();
  const update = await invoke<AppUpdatePayload | null>("check_app_update");

  if (!update) {
    return { status: "up-to-date" };
  }

  const info: UpdateInfo = {
    currentVersion,
    availableVersion: update.availableVersion ?? "",
    notes: update.notes ?? undefined,
    pubDate: update.pubDate ?? undefined,
  };

  return { status: "available", info };
}
