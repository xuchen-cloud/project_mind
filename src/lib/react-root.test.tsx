import { useEffect, useState } from "react";
import { act } from "@testing-library/react";
import { createPortal } from "react-dom";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots = new Set<Root>();
const containers: HTMLElement[] = [];

function makeContainer() {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  return container;
}

afterEach(async () => {
  try {
    await act(async () => {
      for (const root of roots) root.unmount();
    });
  } finally {
    roots.clear();
    for (const container of containers.splice(0)) container.remove();
    vi.restoreAllMocks();
  }
});

describe("renderReactRoot", () => {
  it("reuses the root across module re-evaluation so existing state can remove its DOM safely", async () => {
    const container = makeContainer();
    const hotData: { reactRoot?: Root } = {};
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let removeOldDiv!: () => void;

    function WorkspaceLayout() {
      const [visible, setVisible] = useState(true);
      useEffect(() => {
        removeOldDiv = () => setVisible(false);
      }, []);
      return visible ? <div>Workspace</div> : null;
    }

    const firstModule = await import("./react-root");
    await act(async () => {
      roots.add(firstModule.renderReactRoot(container, <WorkspaceLayout />, hotData));
    });
    const firstDiv = container.firstChild;
    const firstRemove = removeOldDiv;
    expect(firstDiv).toHaveTextContent("Workspace");

    vi.resetModules();
    const updatedModule = await import("./react-root");
    expect(updatedModule.renderReactRoot).not.toBe(firstModule.renderReactRoot);
    await act(async () => {
      roots.add(updatedModule.renderReactRoot(container, <WorkspaceLayout />, hotData));
    });

    // A second createRoot replaces firstDiv without unmounting its old fiber.
    // Updating that fiber then calls the real removeChild on a detached node.
    expect.soft(container.firstChild).toBe(firstDiv);
    expect.soft(errors.mock.calls).toEqual([]);
    let updateError: unknown;
    try {
      await act(async () => firstRemove());
    } catch (error) {
      updateError = error instanceof DOMException ? { name: error.name, message: error.message } : error;
    }
    expect.soft(updateError).toBeUndefined();
    expect.soft(errors.mock.calls).toEqual([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("unmounts the previous keyed route tree and its portal when the router generation changes", async () => {
    const container = makeContainer();
    const portalContainer = makeContainer();
    const hotData: { reactRoot?: Root } = {};
    const cleanup = vi.fn();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let updateOldTree!: () => void;

    function Workspace({ generation }: { generation: number }) {
      const [visible, setVisible] = useState(true);
      useEffect(() => {
        updateOldTree = () => setVisible(false);
        return cleanup;
      }, []);
      return visible ? <div>Workspace {generation}{createPortal(<div>Dialog {generation}</div>, portalContainer)}</div> : null;
    }

    const { renderReactRoot } = await import("./react-root");
    await act(async () => {
      roots.add(renderReactRoot(container, <Workspace key={1} generation={1} />, hotData));
    });
    expect(portalContainer).toHaveTextContent("Dialog 1");
    const oldPortal = portalContainer.firstChild;
    const oldUpdate = updateOldTree;

    vi.resetModules();
    const updatedModule = await import("./react-root");
    await act(async () => {
      roots.add(updatedModule.renderReactRoot(container, <Workspace key={2} generation={2} />, hotData));
    });
    expect.soft(cleanup).toHaveBeenCalledTimes(1);
    expect.soft(oldPortal?.isConnected).toBe(false);
    expect.soft(portalContainer).toHaveTextContent(/^Dialog 2$/);
    await act(async () => oldUpdate());
    expect(container).toHaveTextContent("Workspace 2");
    expect(portalContainer).toHaveTextContent(/^Dialog 2$/);
    expect(errors.mock.calls).toEqual([]);
  });

  it("mounts and unmounts independent production roots without hot data", async () => {
    const mainContainer = makeContainer();
    const voiceContainer = makeContainer();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { renderReactRoot } = await import("./react-root");
    await act(async () => {
      roots.add(renderReactRoot(mainContainer, <div>Main window</div>));
      roots.add(renderReactRoot(voiceContainer, <div>Voice window</div>));
    });
    expect(mainContainer).toHaveTextContent("Main window");
    expect(voiceContainer).toHaveTextContent("Voice window");
    await act(async () => {
      for (const root of roots) root.unmount();
    });
    roots.clear();
    expect(mainContainer).toBeEmptyDOMElement();
    expect(voiceContainer).toBeEmptyDOMElement();
    expect(errors.mock.calls).toEqual([]);
  });
});
