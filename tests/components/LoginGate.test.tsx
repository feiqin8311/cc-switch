import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginGate } from "@/components/auth/LoginGate";
import type { EnterpriseState } from "@/types/enterprise";

const login = vi.fn();
let auth: {
  state: EnterpriseState;
  isLoading: boolean;
  login: typeof login;
};

vi.mock("@/config/edition", () => ({ CODEX_ONLY: true }));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => auth,
}));

const signedOut: EnterpriseState = {
  serverUrl: "https://ent.example",
  loggedIn: false,
  offline: false,
  user: null,
  permissions: [],
  config: null,
  lastError: null,
};

function renderGate() {
  return render(
    <LoginGate>
      <div>the app</div>
    </LoginGate>,
  );
}

describe("LoginGate", () => {
  beforeEach(() => {
    login.mockReset();
    auth = { state: signedOut, isLoading: false, login };
  });

  it("blocks the app until sign-in and has no cancel", () => {
    renderGate();
    expect(screen.queryByText("the app")).not.toBeInTheDocument();
    expect(screen.getByText("enterprise.loginRequired")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "common.cancel" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the app unmounted while the saved session is restoring", () => {
    auth = { state: signedOut, isLoading: true, login };
    renderGate();
    expect(screen.queryByText("the app")).not.toBeInTheDocument();
    expect(screen.getByText("common.loading")).toBeInTheDocument();
  });

  it("lets a restored session straight into the app", () => {
    auth = {
      state: { ...signedOut, loggedIn: true },
      isLoading: false,
      login,
    };
    renderGate();
    expect(screen.getByText("the app")).toBeInTheDocument();
  });

  it("submits credentials and stays put when sign-in fails", async () => {
    login.mockRejectedValue("bad credentials");
    renderGate();
    fireEvent.change(screen.getByLabelText("enterprise.username"), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByLabelText("enterprise.password"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "enterprise.login" }));

    await waitFor(() =>
      expect(login).toHaveBeenCalledWith("https://ent.example", "alice", "secret"),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "bad credentials",
    );
    expect(screen.queryByText("the app")).not.toBeInTheDocument();
  });
});
