/** Where the refresh token is kept between reloads. */
export interface TokenStore {
  get(): string | null;
  set(token: string | null): void;
}

const KEY = "ccse.admin.refreshToken";

/**
 * sessionStorage-backed store: survives a reload, scoped to the tab.
 * Storage can be unavailable (privacy mode, disabled site data); then the
 * session simply does not survive a reload.
 */
export const sessionTokenStore: TokenStore = {
  get() {
    try {
      return window.sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set(token) {
    try {
      if (token === null) window.sessionStorage.removeItem(KEY);
      else window.sessionStorage.setItem(KEY, token);
    } catch {
      // ignore
    }
  },
};

export function memoryTokenStore(initial: string | null = null): TokenStore {
  let value = initial;
  return {
    get: () => value,
    set: (token) => {
      value = token;
    },
  };
}
