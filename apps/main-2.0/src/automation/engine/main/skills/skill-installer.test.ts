import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installBundledSkill, uninstallBundledSkill } from "./skill-installer";

describe("bundled Skill installation", () => {
  it("materializes auxiliary files when the packaged source tree is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentrecall-bundled-skill-"));
    const homeDir = path.join(root, "home");
    const bundledRoot = path.join(root, "bundled-skills");

    try {
      const installed = await installBundledSkill({ templateId: "brainstorming", target: "codex" }, homeDir, bundledRoot);
      const referencePath = path.join(path.dirname(installed.sourcePath), "references", "visual-companion.md");
      await expect(readFile(referencePath, "utf8")).resolves.toContain("visual");
      await expect(readFile(installed.path, "utf8")).resolves.toContain("references/visual-companion.md");

      await uninstallBundledSkill({ templateId: "brainstorming", target: "codex" }, homeDir, bundledRoot);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("materializes every referenced asset for the bundled diagram Skill", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentrecall-bundled-diagram-skill-"));
    const homeDir = path.join(root, "home");
    const bundledRoot = path.join(root, "bundled-skills");

    try {
      const installed = await installBundledSkill({ templateId: "feishu-tech-diagram", target: "codex" }, homeDir, bundledRoot);
      const sourceDir = path.dirname(installed.sourcePath);
      const templateSpecs = JSON.parse(
        await readFile(path.join(sourceDir, "references", "template-specs.json"), "utf8"),
      ) as unknown[];
      expect(templateSpecs).toHaveLength(66);
      await expect(readFile(path.join(sourceDir, "tests", "validate_assets.py"), "utf8"))
        .resolves.toContain("validated prompts=");
      const samples = await readdir(path.join(sourceDir, "assets", "samples"));
      expect(samples.filter((entry) => entry.endsWith(".svg"))).toHaveLength(66);

      await uninstallBundledSkill({ templateId: "feishu-tech-diagram", target: "codex" }, homeDir, bundledRoot);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
