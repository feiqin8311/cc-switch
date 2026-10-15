import {
  MAX_MARKET_PACKAGE_BYTES,
  MAX_PROMPT_DEFINITION_BYTES,
} from "@ccse/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarketUploadForm } from "./MarketUploadForm";

function zipOfSize(size: number, name = "demo.zip"): File {
  const file = new File([new Uint8Array(4)], name, { type: "application/zip" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function fillMetadata() {
  fireEvent.change(screen.getByLabelText(/^ID/), {
    target: { value: "code-review" },
  });
  fireEvent.change(screen.getByLabelText(/^名称/), {
    target: { value: "代码评审" },
  });
  fireEvent.change(screen.getByLabelText(/^版本/), {
    target: { value: "1.0.0" },
  });
}

function pick(file: File) {
  fireEvent.change(screen.getByLabelText(/^安装包/), {
    target: { files: [file] },
  });
}

const submit = () =>
  fireEvent.submit(document.getElementById("mu") as HTMLFormElement);

describe("MarketUploadForm", () => {
  it("rejects packages larger than 20 MB", () => {
    const onSubmit = vi.fn();
    render(<MarketUploadForm formId="mu" onSubmit={onSubmit} />);
    fillMetadata();
    pick(zipOfSize(MAX_MARKET_PACKAGE_BYTES + 1));

    expect(screen.getByText(/超过 20\.0 MB 上限/)).toBeTruthy();
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("rejects non-zip files", () => {
    const onSubmit = vi.fn();
    render(<MarketUploadForm formId="mu" onSubmit={onSubmit} />);
    fillMetadata();
    pick(zipOfSize(100, "demo.tar.gz"));
    submit();
    expect(screen.getByText("只支持 .zip 文件")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits metadata and the file when valid", () => {
    const onSubmit = vi.fn();
    render(<MarketUploadForm formId="mu" onSubmit={onSubmit} />);
    fillMetadata();
    const file = zipOfSize(MAX_MARKET_PACKAGE_BYTES);
    pick(file);
    fireEvent.click(screen.getByRole("switch", { name: "必装" }));
    submit();
    expect(onSubmit).toHaveBeenCalledWith({
      id: "code-review",
      kind: "skill",
      name: "代码评审",
      description: "",
      version: "1.0.0",
      mandatory: true,
      file,
    });
  });

  it("takes an MCP definition as JSON instead of a zip", () => {
    const onSubmit = vi.fn();
    render(<MarketUploadForm formId="mu" onSubmit={onSubmit} />);
    fillMetadata();
    fireEvent.change(screen.getByLabelText(/^类型/), {
      target: { value: "mcp" },
    });
    expect(screen.queryByLabelText(/^安装包/)).toBeNull();
    const textarea = screen.getByLabelText(/^MCP 配置/) as HTMLTextAreaElement;
    expect(JSON.parse(textarea.value)).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    });

    fireEvent.change(textarea, { target: { value: "{ not json" } });
    submit();
    expect(screen.getByText("JSON 格式不正确")).toBeTruthy();

    fireEvent.change(textarea, {
      target: { value: '{"type":"stdio","args":["x"]}' },
    });
    submit();
    expect(screen.getByText(/^MCP 配置不符合要求：command/)).toBeTruthy();

    fireEvent.change(textarea, {
      target: { value: '{"type":"http","url":"ftp://example.com/mcp"}' },
    });
    submit();
    expect(screen.getByText(/^MCP 配置不符合要求：url/)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(textarea, {
      target: {
        value:
          '{\n  "type": "http",\n  "url": "https://mcp.example.com/mcp",\n  "headers": { "X-Team": "core" }\n}',
      },
    });
    submit();
    expect(onSubmit).toHaveBeenCalledWith({
      id: "code-review",
      kind: "mcp",
      name: "代码评审",
      description: "",
      version: "1.0.0",
      mandatory: false,
      definition: {
        type: "http",
        url: "https://mcp.example.com/mcp",
        headers: { "X-Team": "core" },
      },
    });
  });

  it("prefills the current definition when publishing a new MCP version", () => {
    const onSubmit = vi.fn();
    const current =
      '{\n  "type": "sse",\n  "url": "https://mcp.example.com/sse"\n}';
    render(
      <MarketUploadForm
        formId="mu"
        existing={{
          id: "remote",
          kind: "mcp",
          name: "Remote",
          description: "",
          version: "1.0.0",
          mandatory: false,
          sha256: "x",
          sizeBytes: 10,
          updatedAt: new Date(0).toISOString(),
          publishedByName: null,
        }}
        initialDefinition={current}
        onSubmit={onSubmit}
      />,
    );
    const kind = screen.getByLabelText(/^类型/) as HTMLSelectElement;
    expect(kind.disabled).toBe(true);
    expect(
      (screen.getByLabelText(/^MCP 配置/) as HTMLTextAreaElement).value,
    ).toBe(current);
    fireEvent.change(screen.getByLabelText(/^版本/), {
      target: { value: "1.1.0" },
    });
    submit();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "remote",
        kind: "mcp",
        version: "1.1.0",
        definition: { type: "sse", url: "https://mcp.example.com/sse" },
      }),
    );
  });

  it("offers only the page's kinds", () => {
    render(
      <MarketUploadForm
        formId="mu"
        kinds={["skill", "plugin"]}
        onSubmit={vi.fn()}
      />,
    );
    const select = screen.getByLabelText(/^类型/) as HTMLSelectElement;
    expect(Array.from(select.options, (o) => o.value)).toEqual([
      "skill",
      "plugin",
    ]);
  });

  it("has no kind select on the MCP page", () => {
    const onSubmit = vi.fn();
    render(
      <MarketUploadForm formId="mu" kinds={["mcp"]} onSubmit={onSubmit} />,
    );
    expect(screen.queryByLabelText(/^类型/)).toBeNull();
    expect(screen.queryByLabelText(/^安装包/)).toBeNull();
    fillMetadata();
    submit();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "mcp" }),
    );
  });

  it("takes a prompt as Markdown", () => {
    const onSubmit = vi.fn();
    render(
      <MarketUploadForm formId="mu" kinds={["prompt"]} onSubmit={onSubmit} />,
    );
    expect(screen.queryByLabelText(/^类型/)).toBeNull();
    expect(screen.queryByLabelText(/^安装包/)).toBeNull();
    fillMetadata();
    const textarea = screen.getByLabelText(
      /^提示词内容/,
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
    expect(screen.getByText(/覆盖员工当前的 AGENTS\.md/)).toBeTruthy();

    submit();
    expect(screen.getByText("请填写提示词内容")).toBeTruthy();
    fireEvent.change(textarea, { target: { value: "  \n\t " } });
    submit();
    expect(screen.getByText("请填写提示词内容")).toBeTruthy();

    fireEvent.change(textarea, {
      target: { value: "x".repeat(MAX_PROMPT_DEFINITION_BYTES) },
    });
    submit();
    expect(screen.getByText(/超过 256\.0 KB 上限/)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();

    const content = "# 团队约定\n- 回答使用中文\n";
    fireEvent.change(textarea, { target: { value: content } });
    submit();
    expect(onSubmit).toHaveBeenCalledWith({
      id: "code-review",
      kind: "prompt",
      name: "代码评审",
      description: "",
      version: "1.0.0",
      mandatory: false,
      definition: { content },
    });
  });

  it("prefills the current content when publishing a new prompt version", () => {
    const onSubmit = vi.fn();
    render(
      <MarketUploadForm
        formId="mu"
        kinds={["prompt"]}
        existing={{
          id: "team-rules",
          kind: "prompt",
          name: "团队约定",
          description: "",
          version: "1.0.0",
          mandatory: true,
          sha256: "x",
          sizeBytes: 10,
          updatedAt: new Date(0).toISOString(),
          publishedByName: null,
        }}
        initialDefinition="# 旧内容"
        onSubmit={onSubmit}
      />,
    );
    expect(
      (screen.getByLabelText(/^提示词内容/) as HTMLTextAreaElement).value,
    ).toBe("# 旧内容");
    fireEvent.change(screen.getByLabelText(/^版本/), {
      target: { value: "1.1.0" },
    });
    submit();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "team-rules",
        kind: "prompt",
        version: "1.1.0",
        mandatory: true,
        definition: { content: "# 旧内容" },
      }),
    );
  });
});
