import { describe, expect, it } from "vitest";

import { fileHref, fileUriToPath } from "./formatters";

describe("fileHref", () => {
  it("builds posix file urls", () => {
    expect(fileHref("/tmp/demo file.txt")).toBe("file:///tmp/demo%20file.txt");
  });

  it("builds windows drive file urls", () => {
    expect(fileHref("C:\\Users\\demo\\My File.txt")).toBe(
      "file:///C:/Users/demo/My%20File.txt",
    );
  });

  it("builds windows network share urls", () => {
    expect(fileHref("\\\\server\\share\\demo file.txt")).toBe(
      "file://server/share/demo%20file.txt",
    );
  });
});

describe("fileUriToPath", () => {
  it("parses posix file urls", () => {
    expect(fileUriToPath("file:///tmp/demo%20file.txt")).toBe("/tmp/demo file.txt");
  });

  it("parses windows drive file urls", () => {
    expect(fileUriToPath("file:///C:/Users/demo/My%20File.txt")).toBe(
      "C:\\Users\\demo\\My File.txt",
    );
  });

  it("parses windows network share urls", () => {
    expect(fileUriToPath("file://server/share/demo%20file.txt")).toBe(
      "\\\\server\\share\\demo file.txt",
    );
  });

  it("treats localhost file urls as local paths instead of network shares", () => {
    expect(fileUriToPath("file://localhost/tmp/demo%20file.txt")).toBe("/tmp/demo file.txt");
  });
});
