import { describe, expect, it } from "vitest";
import { parseDatasetCases } from "./eval-case-import";

describe("parseDatasetCases", () => {
  it("reads a JSON array of objects with the common field names", () => {
    const result = parseDatasetCases(JSON.stringify([
      { input: "why did login fail?", expectedOutput: "expired token", context: "auth" },
      { prompt: "refresh it how?", answer: "call /refresh" },
      { question: "and then?" },
    ]));

    expect(result.format).toBe("json");
    expect(result.errors).toEqual([]);
    expect(result.cases).toEqual([
      { input: "why did login fail?", expectedOutput: "expired token", context: "auth" },
      { input: "refresh it how?", expectedOutput: "call /refresh" },
      { input: "and then?" },
    ]);
  });

  it("reads a JSON array of plain strings", () => {
    expect(parseDatasetCases('["first", "second"]').cases).toEqual([
      { input: "first" },
      { input: "second" },
    ]);
  });

  it("accepts an exported dataset object and reads context out of metadata", () => {
    const result = parseDatasetCases(JSON.stringify({
      name: "exported",
      items: [{ input: "one", metadata: { context: "from metadata" } }],
    }));

    expect(result.cases).toEqual([{ input: "one", context: "from metadata" }]);
  });

  it("reads tab-separated rows as input, expected output and context", () => {
    const result = parseDatasetCases("first\t1\tctx\nsecond\t2\n\nthird");

    expect(result.format).toBe("delimited");
    expect(result.cases).toEqual([
      { input: "first", expectedOutput: "1", context: "ctx" },
      { input: "second", expectedOutput: "2" },
      { input: "third" },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("names the rows it could not read instead of dropping them quietly", () => {
    const result = parseDatasetCases(JSON.stringify([
      { input: "good" },
      { expectedOutput: "no input here" },
      42,
      "",
    ]));

    expect(result.cases).toEqual([{ input: "good" }]);
    expect(result.errors).toEqual([
      "第 2 条：缺少 input。",
      "第 3 条：既不是字符串也不是对象。",
      "第 4 条：内容为空。",
    ]);
  });

  it("reports unusable JSON rather than pretending nothing was pasted", () => {
    const result = parseDatasetCases("[{ input: not json }]");

    expect(result.cases).toEqual([]);
    expect(result.errors[0]).toContain("JSON 解析失败");
  });

  it("reports the rows dropped by the import cap", () => {
    const rows = Array.from({ length: 501 }, (_unused, index) => ({ input: `case ${index}` }));

    const result = parseDatasetCases(JSON.stringify(rows));

    expect(result.cases).toHaveLength(500);
    // Silent truncation would read as a complete import of everything pasted.
    expect(result.errors[0]).toContain("最多导入 500 条");
  });

  it("treats empty input as empty rather than an error", () => {
    expect(parseDatasetCases("   \n  ")).toEqual({ cases: [], errors: [], format: "empty" });
  });
});
