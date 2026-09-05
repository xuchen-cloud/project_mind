import { describe, expect, it } from "vitest";

import { fileHref, fileUriToPath, preserveRecordFilters } from "./formatters";

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

  it("parses Tauri asset urls as local paths", () => {
    expect(fileUriToPath("asset:///tmp/demo%20file.txt")).toBe("/tmp/demo file.txt");
  });

  it("parses Windows drive asset urls", () => {
    expect(fileUriToPath("asset:///C:/Users/demo/My%20File.txt")).toBe(
      "C:\\Users\\demo\\My File.txt",
    );
  });
});

describe("preserveRecordFilters", () => {
  it("carries record search and tag filters into a focus route", () => {
    expect(
      preserveRecordFilters(
        "/projects/7/records/3",
        "?view=record&recordQuery=budget&recordTag=9",
      ),
    ).toBe("/projects/7/records/3?recordQuery=budget&recordTag=9");
  });

  it("keeps target route parameters and ignores unrelated current parameters", () => {
    expect(
      preserveRecordFilters(
        "/projects/7?focus=record-3",
        new URLSearchParams("compose=record&recordQuery=review"),
      ),
    ).toBe("/projects/7?focus=record-3&recordQuery=review");
  });
});
