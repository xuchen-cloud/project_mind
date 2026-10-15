import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedDocumentVersion } from "../lib/types";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), commit: vi.fn(), confirm: vi.fn() }));
vi.mock("./projectMindApi", () => ({ projectMindApi: { documentVersionPrepare: mocks.prepare, documentAddVersion: mocks.commit } }));
vi.mock("./desktopApi", () => ({ desktopApi: { confirm: mocks.confirm } }));
import { commitDocumentVersion } from "./documentVersionAction";

const target = { documentId: 12, projectId: 3, managedPath: "/workspace/project/file.txt", expectedVersionNumber: 2 };
const prepared: PreparedDocumentVersion = {
  binding: { workspaceId: "workspace", generation: "opened" },
  intent: { ...target, expectedContentHash: "sha256:current", registeredContentHash: "sha256:current", newContentHash: "sha256:current" },
};
describe("File GUI version action", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.prepare.mockResolvedValue(structuredClone(prepared)); });

  it("commits the displayed target with a stable request identity and returns noChange", async () => {
    const result = { receipt: { documentId: 12, versionNumber: 2, contentHash: "sha256:current", noChange: true }, versionPath: target.managedPath };
    mocks.commit.mockResolvedValue(result);
    expect(await commitDocumentVersion(target)).toEqual(result);
    expect(mocks.prepare).toHaveBeenCalledWith(target);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.commit).toHaveBeenCalledWith({ ...prepared, requestId: expect.any(String), registerCurrentBytes: false });
  });

  it.each([null, "sha256:registered-original"])("keeps unknown or edited bytes untouched when registration is cancelled (%s)", async (registeredContentHash) => {
    mocks.prepare.mockResolvedValue({ ...prepared, intent: { ...prepared.intent, registeredContentHash } });
    mocks.confirm.mockResolvedValue(false);
    expect(await commitDocumentVersion(target)).toBeNull();
    expect(mocks.confirm).toHaveBeenCalledWith(expect.stringMatching(/旧版本/), "登记文件版本");
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("keeps the original binding and hashes across a delayed registration confirmation", async () => {
    const frozen = { ...prepared, intent: { ...prepared.intent, registeredContentHash: null } };
    mocks.prepare.mockResolvedValue(frozen);
    let accept!: (accepted: boolean) => void;
    mocks.confirm.mockImplementation(() => new Promise<boolean>((resolve) => { accept = resolve; }));
    const action = commitDocumentVersion(target);
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    // The backend, rather than a silent reread/rebase, rejects this old intent.
    mocks.prepare.mockResolvedValue({ ...prepared, binding: { ...prepared.binding, generation: "reopened" } });
    mocks.commit.mockRejectedValue(new Error("WORKSPACE_CHANGED"));
    accept(true);
    await expect(action).rejects.toThrow("WORKSPACE_CHANGED");
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.commit).toHaveBeenCalledWith({ ...frozen, requestId: expect.any(String), registerCurrentBytes: true });
  });

  it("does not commit when preflight fails for a stale displayed version", async () => {
    mocks.prepare.mockRejectedValue(new Error("REVISION_CONFLICT"));
    await expect(commitDocumentVersion(target)).rejects.toThrow("REVISION_CONFLICT");
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });
});
