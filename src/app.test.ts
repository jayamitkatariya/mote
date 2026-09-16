// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "./store";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(async () => () => undefined),
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
}));

import { mountApp } from "./app";

const legacyDoc = {
  version: 1,
  notes: [
    {
      id: "a",
      title: "TTD :",
      body: "TTD :\n#work #urgent",
      createdAt: 1,
      updatedAt: 5,
    },
    {
      id: "b",
      title: "Old thought",
      body: "Old thought",
      createdAt: 2,
      updatedAt: 4,
      closedAt: 9,
    },
  ],
  tabOrder: ["a"],
  activeId: "a",
  settings: { shakeEnabled: false, pinnedIds: [] },
};

async function setup() {
  const store = await Store.open({
    load: async () => legacyDoc,
    save: async () => undefined,
  });
  document.body.innerHTML = '<div id="app"></div>';
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => undefined;
  }
  mountApp(store);
  return store;
}

describe("mountApp", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the migrated notes into tabs and the editor", async () => {
    const store = await setup();
    const tabs = document.querySelectorAll("#tabs .tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0].querySelector(".tab-title")?.textContent).toBe("TTD :");
    expect((document.querySelector("#editor") as HTMLTextAreaElement).value).toContain("#work");
    expect(document.querySelector("#note-count")?.textContent).toBe("1 note");
    expect(document.querySelector("#attachment-tray")?.hasAttribute("hidden")).toBe(true);
    expect(store.find("a")?.color).toBeUndefined();
  });

  it("creates notes and tints them with the color swatches", async () => {
    const store = await setup();
    (document.querySelector("#new-note") as HTMLButtonElement).click();
    expect(document.querySelectorAll("#tabs .tab")).toHaveLength(2);

    (document.querySelector("#note-color") as HTMLButtonElement).click();
    const popover = document.querySelector("#color-popover") as HTMLDivElement;
    expect(popover.hasAttribute("hidden")).toBe(false);
    expect(popover.querySelectorAll(".swatch")).toHaveLength(8);

    (popover.querySelector(".swatch") as HTMLButtonElement).click();
    expect(store.active()?.color).toBe("yellow");
    expect(document.querySelector("#tabs .tab-color")).not.toBeNull();
    expect(popover.hasAttribute("hidden")).toBe(true);
  });

  it("filters notes by tag in the palette", async () => {
    await setup();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    const overlay = document.querySelector("#palette-overlay") as HTMLDivElement;
    expect(overlay.hasAttribute("hidden")).toBe(false);

    const input = document.querySelector("#palette-input") as HTMLInputElement;
    input.value = "#work";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    const titles = [...document.querySelectorAll("#palette-list .palette-title")].map(
      (node) => node.textContent,
    );
    expect(titles).toContain("TTD :");

    input.value = "#nope";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const filtered = [...document.querySelectorAll("#palette-list .palette-title")].map(
      (node) => node.textContent,
    );
    expect(filtered).not.toContain("TTD :");
  });

  it("opens settings and trash from the titlebar", async () => {
    await setup();
    (document.querySelector("#open-settings") as HTMLButtonElement).click();
    const settings = document.querySelector("#settings-overlay") as HTMLDivElement;
    expect(settings.hasAttribute("hidden")).toBe(false);
    expect((document.querySelector("#set-opacity") as HTMLInputElement).value).toBe("0.96");

    (document.querySelector("#open-trash") as HTMLButtonElement).click();
    const trash = document.querySelector("#trash-overlay") as HTMLDivElement;
    expect(trash.hasAttribute("hidden")).toBe(false);
    expect(document.querySelectorAll("#trash-list .trash-item")).toHaveLength(1);
    expect(document.querySelector(".trash-title")?.textContent).toBe("Old thought");
  });

  it("closes the overlay on escape", async () => {
    await setup();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector("#palette-overlay")?.hasAttribute("hidden")).toBe(true);
  });
});
