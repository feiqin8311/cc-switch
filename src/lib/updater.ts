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

export interface AppUpdatePayload {
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

/**
 * 后台静默下载新版本（Rust 侧会校验签名）。下好返回该版本信息，
 * 之后点“立即重启”直接安装，不再下载。没有更新时返回 null。
 */
export async function downloadUpdate(): Promise<AppUpdatePayload | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<AppUpdatePayload | null>("download_app_update");
}
