import { invoke } from "@tauri-apps/api/core";
import type {
  MarketItem,
  MarketItemKind,
} from "../../../enterprise/contracts/src/index.ts";

export type { MarketItem, MarketItemKind };

/** One marketplace row with local install state (Rust `MarketListEntry`). */
export interface EnterpriseMarketEntry {
  item: MarketItem;
  /** Installed version, or null when not installed. */
  installedVersion: string | null;
  updateAvailable: boolean;
}

export const enterpriseMarketApi = {
  /** Empty when signed out or without `market.install`. */
  list: () => invoke<EnterpriseMarketEntry[]>("enterprise_market_list"),

  /** Install or update. */
  install: (id: string) =>
    invoke<EnterpriseMarketEntry>("enterprise_market_install", { id }),

  /** Mandatory items are refused by the backend. */
  uninstall: (id: string) =>
    invoke<void>("enterprise_market_uninstall", { id }),
};
