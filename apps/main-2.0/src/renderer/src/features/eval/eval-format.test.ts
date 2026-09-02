import { describe, expect, it } from "vitest";
import { nodeStatusClass, runStatusClass } from "./eval-format";

/**
 * Colour is how these pages say what happened, so the mapping is a contract
 * rather than decoration: green decided and met, red decided and unmet, amber
 * something broke, grey nothing was decided.
 */
describe("status colours", () => {
  it("reads a met step as a success and an unmet one as a failure", () => {
    expect(nodeStatusClass("pass")).toBe("eval-badge-ok");
    expect(nodeStatusClass("fail")).toBe("eval-badge-warn");
  });

  it("never paints an excused step as a failure", () => {
    // An excused step means the evaluation could not judge. Sharing red with a
    // genuine failure would undo the whole distinction the engine keeps.
    for (const status of ["excused", "pending", "disabled"] as const) {
      expect(nodeStatusClass(status)).toBe("eval-badge-dim");
    }
    expect(nodeStatusClass("excused")).not.toBe(nodeStatusClass("fail"));
  });

  it("marks a step that broke as needing attention, apart from both", () => {
    expect(nodeStatusClass("error")).toBe("eval-badge-attn");
    expect(nodeStatusClass("error")).not.toBe(nodeStatusClass("fail"));
    expect(nodeStatusClass("error")).not.toBe(nodeStatusClass("excused"));
  });

  it("gives a run the same four readings", () => {
    expect(runStatusClass("completed")).toBe("eval-badge-ok");
    expect(runStatusClass("failed")).toBe("eval-badge-warn");
    expect(runStatusClass("running")).toBe("eval-badge-attn");
    expect(runStatusClass("pending")).toBe("eval-badge-attn");
    // Cancelled decided nothing, so it is neither a pass nor a failure.
    expect(runStatusClass("cancelled")).toBe("eval-badge-dim");
  });
});
