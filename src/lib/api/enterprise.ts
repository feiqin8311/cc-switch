import { invoke } from "@tauri-apps/api/core";
import type { EnterpriseState } from "@/types/enterprise";

export const enterpriseApi = {
  getState: () => invoke<EnterpriseState>("enterprise_get_state"),

  login: (serverUrl: string, username: string, password: string) =>
    invoke<EnterpriseState>("enterprise_login", {
      serverUrl,
      username,
      password,
    }),

  logout: () => invoke<EnterpriseState>("enterprise_logout"),

  refreshConfig: () => invoke<EnterpriseState>("enterprise_refresh_config"),
};
