import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderForm } from "./ProviderForm";

vi.mock("./UsersPage", () => ({
  useUsers: () => ({
    data: {
      items: [
        {
          id: "u-admin",
          username: "admin",
          displayName: "Admin",
          role: "admin",
          groupName: "Dev",
          disabled: false,
          createdAt: "",
          lastLoginAt: null,
          upstreamAccountIds: [],
        },
        {
          id: "u-member",
          username: "member",
          displayName: "Member",
          role: "member",
          groupName: "Dev",
          disabled: false,
          createdAt: "",
          lastLoginAt: null,
          upstreamAccountIds: [],
        },
      ],
    },
  }),
}));

function fill(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function submit() {
  const form = document.getElementById("pf") as HTMLFormElement;
  fireEvent.submit(form);
}

function fillValidBasics() {
  fill(/^ID/, "openai-main");
  fill(/^名称/, "OpenAI");
  fill(/^上游地址/, "https://api.openai.com/v1");
  fill(/^API Key/, "sk-test-123");
  fill("模型 1 ID", "gpt-5");
  fill("模型 1 显示名", "GPT-5");
}

describe("ProviderForm", () => {
  it("rejects a default model that is no longer in the model list", () => {
    const onSubmit = vi.fn();
    render(<ProviderForm formId="pf" mode="create" onSubmit={onSubmit} />);
    fillValidBasics();
    fireEvent.click(screen.getByRole("button", { name: "+ 添加模型" }));
    fill("模型 2 ID", "gpt-5-mini");
    fill("模型 2 显示名", "GPT-5 mini");
    fill(/^默认模型/, "gpt-5-mini");
    // Removing the selected default model leaves the selection dangling.
    fireEvent.click(screen.getByRole("button", { name: "删除模型 2" }));
    submit();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("默认模型必须是模型列表中的一项")).toBeTruthy();
  });

  it("submits a normalized payload when valid", () => {
    const onSubmit = vi.fn();
    render(<ProviderForm formId="pf" mode="create" onSubmit={onSubmit} />);
    fillValidBasics();
    fill(/^默认模型/, "gpt-5");
    fireEvent.click(screen.getByLabelText("Dev"));
    fireEvent.click(screen.getByLabelText(/^member/));
    submit();

    expect(onSubmit).toHaveBeenCalledWith({
      id: "openai-main",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      wireApi: "responses",
      apiKey: "sk-test-123",
      models: [{ id: "gpt-5", displayName: "GPT-5" }],
      defaultModel: "gpt-5",
      allowedUserIds: ["u-member"],
      allowedGroups: ["Dev"],
      enabled: true,
    });
  });

  it("submits chat_completions wireApi when selected", () => {
    const onSubmit = vi.fn();
    render(<ProviderForm formId="pf" mode="create" onSubmit={onSubmit} />);
    fillValidBasics();
    fill(/^默认模型/, "gpt-5");
    fireEvent.change(screen.getByLabelText(/^协议类型/), {
      target: { value: "chat_completions" },
    });
    submit();

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        wireApi: "chat_completions",
      }),
    );
  });

  it("omits an empty apiKey when editing and requires it when creating", () => {
    const onSubmit = vi.fn();
    const { unmount } = render(
      <ProviderForm formId="pf" mode="create" onSubmit={onSubmit} />,
    );
    fillValidBasics();
    fill(/^API Key/, "");
    fill(/^默认模型/, "gpt-5");
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("请输入 API Key")).toBeTruthy();
    unmount();

    render(
      <ProviderForm
        formId="pf"
        mode="edit"
        provider={{
          id: "openai-main",
          name: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          wireApi: "responses",
          apiKeyHint: "sk-…a1b2",
          models: [{ id: "gpt-5", displayName: "GPT-5" }],
          defaultModel: "gpt-5",
          allowedUserIds: ["u-admin"],
          allowedGroups: ["Dev"],
          dailyTokenLimitPerUser: null,
          enabled: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByText(/sk-…a1b2/)).toBeTruthy();
    submit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("apiKey");
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      allowedUserIds: ["u-admin"],
      allowedGroups: ["Dev"],
    });
  });
});
