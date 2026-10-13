import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderModelSelect } from "@/components/providers/ProviderModelSelect";
import { ProviderCardActions } from "@/components/providers/ProviderCardActions";
import type { Provider } from "@/types";
import { createTestQueryClient } from "../utils/testQueryClient";

const invokeMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/toast", () => ({
  toast: { error: toastErrorMock, success: vi.fn(), info: vi.fn() },
}));

// Radix Select needs pointer APIs jsdom lacks; a native select keeps the
// contract (value / onValueChange / items) testable.
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, disabled, children }: any) => (
    <select
      data-testid="model-select"
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange?.(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ value, children }: any) => (
    <option value={value}>{children}</option>
  ),
}));

const enterpriseCard = (model = "gpt-5"): Provider => ({
  id: "ccse-openai-main",
  name: "OpenAI (Enterprise)",
  category: "custom",
  settingsConfig: {
    auth: { OPENAI_API_KEY: "gk_x" },
    config: `model_provider = "custom"\nmodel = "${model}"\n`,
  },
  meta: {
    enterprise: {
      serverUrl: "https://ent.example.com",
      providerId: "openai-main",
      models: [
        { id: "gpt-5", displayName: "GPT-5" },
        { id: "gpt-5-mini", displayName: "GPT-5 mini" },
      ],
    },
  } as Provider["meta"],
});

function renderSelect(provider: Provider) {
  const queryClient = createTestQueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ProviderModelSelect provider={provider} />
    </QueryClientProvider>,
  );
  return { ...view, invalidate };
}

describe("ProviderModelSelect", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    toastErrorMock.mockReset();
  });

  it("lists the managed models and switches through the API", async () => {
    invokeMock.mockResolvedValue(true);
    const { invalidate } = renderSelect(enterpriseCard());

    const select = screen.getByTestId("model-select") as HTMLSelectElement;
    expect(select.value).toBe("gpt-5");
    expect(
      Array.from(select.options).map((o) => [o.value, o.textContent]),
    ).toEqual([
      ["gpt-5", "GPT-5"],
      ["gpt-5-mini", "GPT-5 mini"],
    ]);

    fireEvent.change(select, { target: { value: "gpt-5-mini" } });

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("codex_set_provider_model", {
        providerId: "ccse-openai-main",
        model: "gpt-5-mini",
      }),
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["providers", "codex"],
      }),
    );
  });

  it("reports a failed switch", async () => {
    invokeMock.mockRejectedValue(new Error("not offered"));
    renderSelect(enterpriseCard());

    fireEvent.change(screen.getByTestId("model-select"), {
      target: { value: "gpt-5-mini" },
    });

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "enterpriseModels.changeFailed",
      ),
    );
  });

  it("uses the model catalog of a regular Codex card", () => {
    renderSelect({
      id: "kimi",
      name: "Kimi",
      settingsConfig: {
        auth: { OPENAI_API_KEY: "sk" },
        config: 'model = "kimi-k3"\n',
        modelCatalog: {
          models: [
            { model: "kimi-k3", displayName: "Kimi K3" },
            { model: "kimi-k2.7-code" },
          ],
        },
      },
    });

    const select = screen.getByTestId("model-select") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Kimi K3",
      "kimi-k2.7-code",
    ]);
  });

  it("renders nothing without a known model list", () => {
    renderSelect({
      id: "plain",
      name: "Plain",
      settingsConfig: { auth: {}, config: 'model = "a"\n' },
    });
    expect(screen.queryByTestId("model-select")).toBeNull();
  });
});

describe("ProviderCardActions — read-only cards", () => {
  it("hides edit, duplicate and delete", async () => {
    const user = userEvent.setup();
    render(
      <ProviderCardActions
        providerName="OpenAI (Enterprise)"
        presentation={{ buttons: [], chips: [] }}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onTest={vi.fn()}
        readOnly
      />,
    );

    expect(
      screen.queryByRole("button", { name: "providerCard.action.edit" }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "providerCard.action.more" }),
    );
    const items = (await screen.findAllByRole("menuitem")).map(
      (item) => item.textContent,
    );
    expect(items).toEqual(["provider.connectivityCheck"]);
  });
});
