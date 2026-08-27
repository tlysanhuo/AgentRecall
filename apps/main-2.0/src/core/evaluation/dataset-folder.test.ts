import { describe, expect, it } from "vitest";
import {
  compareCaseFileNames,
  datasetFolderFiles,
  parseDatasetFolder,
} from "./dataset-folder";

function manifest(body = ""): string {
  return `---\nname: 登录回归\ndescription: 关于登录失败诊断的用例\ntags: [auth, regression]\n---\n\n${body}`;
}

function caseFile(fileName: string, value: unknown): { fileName: string; contents: string } {
  return { fileName, contents: JSON.stringify(value, null, 2) };
}

describe("parseDatasetFolder", () => {
  it("reads the overview from Markdown and the cases from JSON", () => {
    const result = parseDatasetFolder({
      manifest: manifest("这些用例覆盖令牌过期与刷新。\n"),
      cases: [
        caseFile("cases/001-expired.json", {
          id: "expired-token",
          input: "为什么登录会失败？",
          expectedOutput: "令牌过期",
          context: "auth module",
        }),
        caseFile("cases/002-refresh.json", { input: "如何刷新？" }),
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.manifest).toEqual({
      name: "登录回归",
      description: "关于登录失败诊断的用例",
      tags: ["auth", "regression"],
    });
    expect(result.cases).toEqual([
      {
        id: "expired-token",
        input: "为什么登录会失败？",
        expectedOutput: "令牌过期",
        context: "auth module",
        metadata: {},
        fileName: "cases/001-expired.json",
      },
      {
        // No id in the file, so the filename supplies one with its ordering
        // prefix stripped.
        id: "refresh",
        input: "如何刷新？",
        metadata: {},
        fileName: "cases/002-refresh.json",
      },
    ]);
  });

  it("keeps fields it does not recognise instead of dropping them", () => {
    const result = parseDatasetFolder({
      manifest: manifest(),
      cases: [caseFile("cases/001.json", {
        input: "x",
        metadata: { topic: "auth" },
        futureField: "kept",
      })],
    });

    expect(result.cases[0]!.metadata).toEqual({ topic: "auth", futureField: "kept" });
  });

  it("names every unusable file rather than importing a partial dataset quietly", () => {
    const result = parseDatasetFolder({
      manifest: manifest(),
      cases: [
        caseFile("cases/001.json", { input: "good" }),
        { fileName: "cases/002.json", contents: "{ not json }" },
        caseFile("cases/003.json", { expectedOutput: "no input" }),
        caseFile("cases/004.json", ["array"]),
      ],
    });

    expect(result.cases.map((item) => item.input)).toEqual(["good"]);
    expect(result.errors).toEqual([
      expect.stringContaining("cases/002.json: JSON 解析失败"),
      "cases/003.json: 缺少 input。",
      "cases/004.json: 顶层必须是一个 JSON 对象。",
    ]);
  });

  it("refuses two cases that claim the same id", () => {
    // A duplicate id would make a run's per-case records ambiguous, so it is an
    // error rather than a last-one-wins overwrite.
    const result = parseDatasetFolder({
      manifest: manifest(),
      cases: [
        caseFile("cases/001.json", { id: "same", input: "first" }),
        caseFile("cases/002.json", { id: "same", input: "second" }),
      ],
    });

    expect(result.cases.map((item) => item.input)).toEqual(["first"]);
    expect(result.errors).toEqual(['cases/002.json: 用例 id「same」重复。']);
  });

  it("falls back to the folder name when the manifest is missing or unreadable", () => {
    const missing = parseDatasetFolder({
      manifest: null,
      cases: [caseFile("cases/001.json", { input: "x" })],
      folderName: "login-regression",
    });
    expect(missing.manifest.name).toBe("login-regression");
    expect(missing.errors[0]).toContain("缺少 dataset.md");

    const noFrontmatter = parseDatasetFolder({
      manifest: "# 登录回归\n\n没有 frontmatter。",
      cases: [caseFile("cases/001.json", { input: "x" })],
      folderName: "login-regression",
    });
    expect(noFrontmatter.manifest.name).toBe("login-regression");
    expect(noFrontmatter.errors[0]).toContain("缺少 frontmatter");
  });

  it("is not confused by a body that contains a horizontal rule", () => {
    const result = parseDatasetFolder({
      manifest: `${manifest("正文\n\n---\n\n分隔线之后还有内容。")}`,
      cases: [caseFile("cases/001.json", { input: "x" })],
    });

    expect(result.manifest.name).toBe("登录回归");
    expect(result.errors).toEqual([]);
  });

  it("says so when the folder has no cases at all", () => {
    const result = parseDatasetFolder({ manifest: manifest(), cases: [] });

    expect(result.cases).toEqual([]);
    expect(result.errors[0]).toContain("没有找到用例");
  });
});

describe("compareCaseFileNames", () => {
  it("orders numbered files the way a person numbers them", () => {
    const names = ["cases/010-c.json", "cases/002-b.json", "cases/001-a.json"];

    expect([...names].sort(compareCaseFileNames)).toEqual([
      "cases/001-a.json",
      "cases/002-b.json",
      "cases/010-c.json",
    ]);
  });
});

describe("datasetFolderFiles", () => {
  it("writes a folder that parses back into the same dataset", () => {
    const files = datasetFolderFiles({
      name: "登录回归",
      description: "关于登录失败诊断的用例",
      tags: ["auth"],
      cases: [
        { id: "expired-token", input: "为什么登录会失败？", expectedOutput: "令牌过期", context: "auth" },
        { id: "refresh", input: "如何刷新？", metadata: { topic: "auth" } },
      ],
    });

    expect(files.manifest.fileName).toBe("dataset.md");
    expect(files.cases.map((item) => item.fileName)).toEqual([
      "cases/001-expired-token.json",
      "cases/002-refresh.json",
    ]);

    const reparsed = parseDatasetFolder({
      manifest: files.manifest.contents,
      cases: files.cases,
    });
    expect(reparsed.errors).toEqual([]);
    expect(reparsed.manifest).toEqual({
      name: "登录回归",
      description: "关于登录失败诊断的用例",
      tags: ["auth"],
    });
    expect(reparsed.cases.map(({ fileName: _fileName, ...rest }) => rest)).toEqual([
      { id: "expired-token", input: "为什么登录会失败？", expectedOutput: "令牌过期", context: "auth", metadata: {} },
      { id: "refresh", input: "如何刷新？", metadata: { topic: "auth" } },
    ]);
  });

  it("quotes a name that would not survive as a bare YAML scalar", () => {
    const files = datasetFolderFiles({
      name: "tricky: name #1",
      description: "",
      cases: [{ id: "a", input: "x" }],
    });

    expect(files.manifest.contents).toContain('name: "tricky: name #1"');
    expect(parseDatasetFolder({ manifest: files.manifest.contents, cases: files.cases }).manifest.name)
      .toBe("tricky: name #1");
  });
});
