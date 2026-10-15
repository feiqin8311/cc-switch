import { invoke } from "@tauri-apps/api/core";

export interface DwsStatus {
  installed: boolean;
  version: string | null;
  path: string | null;
  loggedIn: boolean;
}

export const dwsApi = {
  status: () => invoke<DwsStatus>("dws_status"),
  install: () => invoke<DwsStatus>("dws_install"),
  openLogin: () => invoke<void>("dws_open_login"),
};
