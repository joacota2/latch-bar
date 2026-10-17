import { useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  FolderGit2,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
  Plus,
  Radar,
  Search,
} from "lucide-react";
import { PageIntro } from "../components/ui";
import {
  chooseWorkspaceFolder,
  copyNativeText,
  isTauri,
} from "../services/runtime";
import { useLatch } from "../store/LatchStore";

export function WorkspacesPage() {
  const {
    workspaces,
    addWorkspace,
    removeWorkspace,
    environmentStatus,
    environmentError,
    refreshCodexEnvironment,
    createAgent,
    notify,
  } = useLatch();
  const [menu, setMenu] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        menuButtonRef.current?.focus();
        setMenu(null);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  const perform = async (action: () => Promise<unknown>) => {
    setMenu(null);
    try {
      await action();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  };
  const chooseFolder = async () => {
    setChoosing(true);
    try {
      const path = await chooseWorkspaceFolder();
      if (path && (await addWorkspace(path))) notify("Workspace saved");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    } finally {
      setChoosing(false);
    }
  };
  return (
    <div className="page catalog-page">
      <PageIntro
        eyebrow="SAVED FOLDERS & RECENT PROJECTS"
        title="Workspaces"
        description="Save local projects or reuse working directories reported by Codex."
        action={
          <button
            className="primary-button"
            disabled={choosing}
            onClick={() => void chooseFolder()}
          >
            <Plus size={15} /> Add workspace
          </button>
        }
      />
      <div className="workspace-detection">
        <span>
          <Radar size={18} />
        </span>
        <div>
          <strong>Workspace discovery</strong>
          <p>
            Saved folders stay available alongside recent Codex thread
            directories.
          </p>
        </div>
        <span className="enabled-pill">
          {environmentStatus === "loading"
            ? "Refreshing"
            : `${workspaces.length} available`}
        </span>
      </div>
      {environmentError && <p role="alert">{environmentError}</p>}
      <div className="workspace-list">
        {workspaces.map((workspace) => (
          <article className="workspace-row" key={workspace.id}>
            <span
              className="workspace-folder"
              style={
                { "--workspace-color": workspace.color } as React.CSSProperties
              }
            >
              <FolderGit2 size={21} />
            </span>
            <div>
              <h3>{workspace.name}</h3>
              <p>{workspace.path}</p>
            </div>
            <span className="branch">
              <GitBranch size={13} />
              {workspace.branch}
            </span>
            <span className="last-used">
              Last used<strong>{workspace.lastUsed}</strong>
            </span>
            <div
              className="workspace-actions"
              ref={menu === workspace.id ? menuRef : undefined}
            >
              <button
                ref={menu === workspace.id ? menuButtonRef : undefined}
                className="ghost-icon"
                aria-label={`Workspace menu for ${workspace.name}`}
                aria-expanded={menu === workspace.id}
                onClick={() =>
                  setMenu(menu === workspace.id ? null : workspace.id)
                }
              >
                <MoreHorizontal size={18} />
              </button>
              {menu === workspace.id && (
                <div
                  className="workspace-menu"
                  aria-label={`${workspace.name} actions`}
                >
                  <button
                    onClick={() =>
                      void perform(async () => {
                        if (!isTauri())
                          throw new Error(
                            "Opening folders requires the desktop app",
                          );
                        await revealItemInDir(workspace.path);
                      })
                    }
                  >
                    Show in Finder
                  </button>
                  <button
                    onClick={() =>
                      void perform(async () => {
                        if (isTauri()) await copyNativeText(workspace.path);
                        else
                          await navigator.clipboard.writeText(workspace.path);
                        notify("Workspace path copied");
                      })
                    }
                  >
                    Copy path
                  </button>
                  <button
                    onClick={() =>
                      void perform(async () => {
                        const saved = await (workspace.saved
                          ? removeWorkspace(workspace.path)
                          : addWorkspace(workspace.path));
                        if (saved)
                          notify(
                            workspace.saved
                              ? "Saved workspace removed; Codex history is unchanged"
                              : "Workspace saved",
                          );
                      })
                    }
                  >
                    {workspace.saved
                      ? "Remove saved workspace"
                      : "Save workspace"}
                  </button>
                  <button
                    onClick={() => {
                      createAgent(workspace.path);
                      setMenu(null);
                    }}
                  >
                    Create agent here
                  </button>
                </div>
              )}
            </div>
          </article>
        ))}
        {workspaces.length === 0 && (
          <div className="info-banner">
            <FolderGit2 size={19} />
            <div>
              <strong>
                {environmentStatus === "loading"
                  ? "Loading recent workspaces"
                  : "No saved or recent workspaces"}
              </strong>
              <p>Choose a local folder or start a Codex thread in a project.</p>
            </div>
          </div>
        )}
      </div>
      <div className="workspace-empty-actions">
        <button disabled={choosing} onClick={() => void chooseFolder()}>
          <FolderOpen size={18} />
          <strong>Choose another folder</strong>
          <span>Add any local project</span>
        </button>
        <button
          disabled={environmentStatus === "loading"}
          onClick={() => void refreshCodexEnvironment()}
        >
          <Search size={18} />
          <strong>Refresh from Codex</strong>
          <span>Reload recent thread directories</span>
        </button>
      </div>
    </div>
  );
}
