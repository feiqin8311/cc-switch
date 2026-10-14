import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import type { UpdateInfo } from "../lib/updater";
import { checkForUpdate, downloadUpdate } from "../lib/updater";
import { extractErrorMessage } from "../utils/errorUtils";

interface UpdateContextValue {
  // 更新状态
  hasUpdate: boolean;
  updateInfo: UpdateInfo | null;
  isChecking: boolean;
  error: string | null;
  /** 已在后台下载并验过签名、可以直接安装的版本 */
  readyVersion: string | null;

  // 提示状态
  isDismissed: boolean;
  dismissUpdate: () => void;

  // 操作方法
  checkUpdate: () => Promise<boolean>;
  resetDismiss: () => void;
}

const UpdateContext = createContext<UpdateContextValue | undefined>(undefined);

/** 托盘应用常驻不重启，所以除了启动时，还要定期查一次。 */
const POLL_INTERVAL_MS = 60 * 60 * 1000;
/** 点“稍后”后，同一版本隔这么久再提醒。 */
const SNOOZE_MS = 4 * 60 * 60 * 1000;
const SNOOZE_KEY = "ccswitch:update:snooze";
// 旧版本“稍后”会永久跳过这个版本，升级后清掉，免得一直不提醒。
const LEGACY_DISMISSED_KEYS = [
  "ccswitch:update:dismissedVersion",
  "dismissedUpdateVersion",
];

interface Snooze {
  version: string;
  until: number;
}

function readSnooze(): Snooze | null {
  try {
    const raw = localStorage.getItem(SNOOZE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Snooze>;
    if (typeof parsed.version !== "string" || typeof parsed.until !== "number")
      return null;
    return { version: parsed.version, until: parsed.until };
  } catch {
    return null;
  }
}

function isSnoozed(version: string): boolean {
  const snooze = readSnooze();
  return snooze?.version === version && Date.now() < snooze.until;
}

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const [hasUpdate, setHasUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);
  const [readyVersion, setReadyVersion] = useState<string | null>(null);

  useEffect(() => {
    try {
      for (const key of LEGACY_DISMISSED_KEYS) localStorage.removeItem(key);
    } catch {
      // 存储不可用时忽略
    }
  }, []);

  const isDownloadingRef = useRef(false);

  // 静默下载；失败不打扰用户，下次检查再试。
  const downloadInBackground = useCallback(async () => {
    if (isDownloadingRef.current) return;
    isDownloadingRef.current = true;
    try {
      const ready = await downloadUpdate();
      setReadyVersion(ready?.availableVersion ?? null);
    } catch (err) {
      console.error("后台下载更新失败:", err);
    } finally {
      isDownloadingRef.current = false;
    }
  }, []);

  const isCheckingRef = useRef(false);

  const checkUpdate = useCallback(async () => {
    if (isCheckingRef.current) return false;
    isCheckingRef.current = true;
    setIsChecking(true);
    setError(null);

    try {
      const result = await checkForUpdate({ timeout: 30000 });

      if (result.status === "available") {
        setHasUpdate(true);
        setUpdateInfo(result.info);
        setIsDismissed(isSnoozed(result.info.availableVersion));
        void downloadInBackground();
        return true; // 有更新
      } else {
        setHasUpdate(false);
        setUpdateInfo(null);
        setReadyVersion(null);
        setIsDismissed(false);
        return false; // 已是最新
      }
    } catch (err) {
      console.error("检查更新失败:", err);
      setError(extractErrorMessage(err) || "检查更新失败");
      setHasUpdate(false);
      throw err; // 抛出错误让调用方处理
    } finally {
      setIsChecking(false);
      isCheckingRef.current = false;
    }
  }, [downloadInBackground]);

  const dismissUpdate = useCallback(() => {
    setIsDismissed(true);
    const version = updateInfo?.availableVersion;
    if (!version) return;
    try {
      localStorage.setItem(
        SNOOZE_KEY,
        JSON.stringify({ version, until: Date.now() + SNOOZE_MS }),
      );
    } catch {
      // 存不下就只在本次运行里推迟
    }
  }, [updateInfo?.availableVersion]);

  const resetDismiss = useCallback(() => {
    setIsDismissed(false);
    try {
      localStorage.removeItem(SNOOZE_KEY);
    } catch {
      // 忽略
    }
  }, []);

  // 启动 1 秒后检查一次（避免影响启动体验），之后每小时检查一次。
  useEffect(() => {
    const run = () => {
      checkUpdate().catch(console.error);
    };
    const timer = setTimeout(run, 1000);
    const interval = setInterval(run, POLL_INTERVAL_MS);

    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [checkUpdate]);

  const value: UpdateContextValue = {
    hasUpdate,
    updateInfo,
    isChecking,
    error,
    readyVersion,
    isDismissed,
    dismissUpdate,
    checkUpdate,
    resetDismiss,
  };

  return (
    <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>
  );
}

export function useUpdate() {
  const context = useContext(UpdateContext);
  if (!context) {
    throw new Error("useUpdate must be used within UpdateProvider");
  }
  return context;
}
