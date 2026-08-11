import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const legacyWorkflowPageRoot = fileURLToPath(
  new URL("../src/automation/engine/renderer/src/pages/workflow", import.meta.url),
);
const legacyWorkflowService = fileURLToPath(
  new URL("../src/automation/engine/renderer/src/app/services/workflow-service.ts", import.meta.url),
);
const legacyPortableWorkflowService = fileURLToPath(
  new URL("../src/main/services/workflow-portable-service.ts", import.meta.url),
);

test("旧 Workflow Renderer 已从 V2 生产代码中移除", () => {
  assert.equal(existsSync(legacyWorkflowPageRoot), false, "旧 Workflow 页面目录不应继续存在");
  assert.equal(existsSync(legacyWorkflowService), false, "旧 Workflow Renderer 服务不应继续存在");
  assert.equal(existsSync(legacyPortableWorkflowService), false, "旧 Workflow 导入导出服务不应继续存在");

  const appState = readFileSync(`${appRoot}/src/automation/engine/renderer/src/app/app-state.ts`, "utf8");
  assert.doesNotMatch(appState, /pages\/workflow/, "共享状态代码不应反向依赖旧 Workflow 页面");

  const workflowFeaturePage = readFileSync(`${appRoot}/src/renderer/src/features/automation/workflow-feature-page.tsx`, "utf8");
  assert.doesNotMatch(
    workflowFeaturePage,
    /engine\/renderer\/src\/pages\/workflow/,
    "当前 Workflow 页面不应重新接回旧 Renderer",
  );

  const preload = readFileSync(`${appRoot}/src/preload/automation.ts`, "utf8");
  assert.doesNotMatch(preload, /createWorkflowDraft|sendWorkflowDraftReply|reviseWorkflowV2Run/);

  const channels = readFileSync(`${appRoot}/src/shared/ipc/automation.ts`, "utf8");
  assert.doesNotMatch(channels, /workflowDraftCreate|workflowReviewApplyToManager|workflowImportBegin/);
});
