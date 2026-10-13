import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";

/** Mirrors the Rust `enterprise::RetentionStatus`. */
export interface RetentionStatus {
  /** Signed in and the server policy is enabled. */
  enabled: boolean;
  noticeText: string;
  /** The current server + user acknowledged the notice on this device. */
  acknowledged: boolean;
  acknowledgedAt: string | null;
  lastUploadAt: string | null;
  lastError: string | null;
  uploadedSessions: number;
}

export const enterpriseRetentionApi = {
  status: () => invoke<RetentionStatus>("enterprise_retention_status"),
  acknowledge: () =>
    invoke<RetentionStatus>("enterprise_retention_acknowledge"),
};

const POLL_INTERVAL_MS = 60 * 1000;

/**
 * Retention status for the signed-in account. The key includes the auth
 * fields that affect it, so login / logout / policy changes refetch at once.
 */
export function useRetentionStatusQuery() {
  const { state } = useAuth();
  const loggedIn = state.loggedIn;
  return useQuery({
    queryKey: [
      "enterpriseRetention",
      "status",
      state.serverUrl,
      state.user?.id ?? null,
      loggedIn,
      state.config?.retention.enabled ?? false,
    ],
    queryFn: enterpriseRetentionApi.status,
    enabled: loggedIn,
    refetchInterval: POLL_INTERVAL_MS,
  });
}
