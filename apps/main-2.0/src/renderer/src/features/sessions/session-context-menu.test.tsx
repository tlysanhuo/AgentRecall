// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentKind, SessionSearchResult } from "../../../../core/types";
import { SessionContextMenu } from "./session-context-menu";

describe("SessionContextMenu migration", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it.each(["ssh", "wsl"] satisfies EnvironmentKind[])(
    "keeps migration enabled for a supported %s session",
    async (environmentKind) => {
      const onMigrate = vi.fn();
      await act(async () => root.render(
        <SessionContextMenu
          state={{ x: 10, y: 10, session: remoteSession(environmentKind) }}
          language="en"
          revealLabel="Explorer"
          showMacActions={false}
          canResume={true}
          canOpenApp={false}
          canStepcodeResume={false}
          canMigrate={true}
          onRename={vi.fn()}
          onAddTag={vi.fn()}
          onSelectMultiple={vi.fn()}
          onFavorite={vi.fn()}
          onHide={vi.fn()}
          onResume={vi.fn()}
          onStepcodeResume={vi.fn()}
          onResumeIterm={vi.fn()}
          onOpenApp={vi.fn()}
          onMigrate={onMigrate}
          onCopyResume={vi.fn()}
          onCopyMarkdown={vi.fn()}
          onExportMarkdown={vi.fn()}
          onExportJson={vi.fn()}
          onDelete={vi.fn()}
          onReveal={vi.fn()}
        />,
      ));

      const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((candidate) => candidate.textContent?.includes("Migrate to"));
      expect(button?.disabled).toBe(false);
      await act(async () => button?.click());
      expect(onMigrate).toHaveBeenCalledOnce();
    },
  );
});

function remoteSession(environmentKind: EnvironmentKind): SessionSearchResult {
  return {
    sessionKey: `${environmentKind}:session`,
    source: "codex-cli",
    environmentId: `${environmentKind}-1`,
    environmentKind,
    environmentLabel: environmentKind.toUpperCase(),
    sourceAvailable: true,
    favorited: false,
    hidden: false,
  } as SessionSearchResult;
}
