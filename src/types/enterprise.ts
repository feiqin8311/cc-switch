// Enterprise center types. Wire types come from the shared contract package;
// `EnterpriseState` mirrors the Rust `enterprise` module (tokens never reach the webview).
import type {
  ClientConfigResponse,
  Permission,
  User,
} from "../../enterprise/contracts/src/index.ts";

export type {
  ClientConfigResponse,
  ManagedProvider,
  Permission,
  RetentionPolicy,
  Role,
  User as EnterpriseUser,
} from "../../enterprise/contracts/src/index.ts";

export interface EnterpriseState {
  serverUrl: string | null;
  loggedIn: boolean;
  /** Server unreachable; `user` / `config` are the last known values. */
  offline: boolean;
  user: User | null;
  permissions: Permission[];
  config: ClientConfigResponse | null;
  lastError: string | null;
}
