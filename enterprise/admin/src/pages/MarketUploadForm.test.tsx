import { MAX_MARKET_PACKAGE_BYTES } from "@ccse/contracts";
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
});
