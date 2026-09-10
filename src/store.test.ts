import { describe, expect, it } from "vitest";
import { deriveTitle, Store, type StorageLike } from "./store";

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("deriveTitle", () => {
  it("uses the first non-empty line", () => {
    expect(deriveTitle("\n\nhello world\nsecond line")).toBe("hello world");
  });

  it("strips markdown-ish prefixes", () => {
    expect(deriveTitle("## shopping list")).toBe("shopping list");
    expect(deriveTitle("- buy milk")).toBe("buy milk");
  });

  it("truncates long lines", () => {
    const title = deriveTitle("x".repeat(120));
    expect(title.length).toBeLessThanOrEqual(48);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("Store", () => {
  it("seeds a welcome note on first run", () => {
    const store = new Store(memoryStorage());
    expect(store.notes()).toHaveLength(1);
    expect(store.active()?.body).toContain("welcome to mote");
  });

  it("persists notes across instances", () => {
    const storage = memoryStorage();
    const first = new Store(storage);
    const note = first.create("persisted note");
    first.updateBody(note.id, "persisted note\nwith more text");
    first.flush();

    const second = new Store(storage);
    const restored = second.notes().find((value) => value.id === note.id);
    expect(restored?.body).toBe("persisted note\nwith more text");
    expect(restored?.title).toBe("persisted note");
  });

  it("archives the last note instead of deleting it", () => {
    const store = new Store(memoryStorage());
    const id = store.notes()[0].id;
    store.close(id);
    expect(store.notes()).toHaveLength(1);
    expect(store.notes()[0].id).not.toBe(id);
    expect(store.doc.notes).toHaveLength(2);

    const archived = store.doc.notes.find((note) => note.id === id);
    expect(archived?.closedAt).toBeTypeOf("number");
  });

  it("reopens a closed note from search", () => {
    const store = new Store(memoryStorage());
    const id = store.notes()[0].id;
    store.close(id);
    store.open(id);

    expect(store.doc.tabOrder).toContain(id);
    expect(store.doc.activeId).toBe(id);
    const reopened = store.doc.notes.find((note) => note.id === id);
    expect(reopened?.closedAt).toBeUndefined();
  });

  it("moves selection after closing the active tab", () => {
    const store = new Store(memoryStorage());
    const second = store.create("second");
    const third = store.create("third");
    store.open(second.id);
    store.close(second.id);
    expect(store.doc.activeId).toBe(third.id);
    expect(store.doc.notes.some((note) => note.id === second.id)).toBe(true);
  });

  it("recovers from corrupted storage", () => {
    const storage = memoryStorage();
    storage.setItem("mote.doc.v1", "{not json");
    const store = new Store(storage);
    expect(store.notes().length).toBeGreaterThan(0);
  });

  it("merges missing settings with defaults", () => {
    const storage = memoryStorage();
    storage.setItem(
      "mote.doc.v1",
      JSON.stringify({
        version: 1,
        notes: [
          { id: "a", title: "a", body: "a", createdAt: 1, updatedAt: 1 },
        ],
        tabOrder: ["a"],
        activeId: "a",
        settings: { shakeEnabled: false },
      }),
    );
    const store = new Store(storage);
    expect(store.doc.settings.shakeEnabled).toBe(false);
    expect(store.doc.settings.shakeSensitivity).toBe(3);
    expect(store.doc.settings.hideOnBlur).toBe(true);
  });

  it("reseeds the welcome note when storage has no notes", () => {
    const storage = memoryStorage();
    storage.setItem(
      "mote.doc.v1",
      JSON.stringify({ version: 1, notes: [], tabOrder: [], activeId: null, settings: {} }),
    );
    const store = new Store(storage);
    expect(store.notes()).toHaveLength(1);
    expect(store.active()?.body).toContain("welcome to mote");
  });

  it("restores the active note into the tab order", () => {
    const storage = memoryStorage();
    storage.setItem(
      "mote.doc.v1",
      JSON.stringify({
        version: 1,
        notes: [{ id: "a", title: "a", body: "a", createdAt: 1, updatedAt: 1 }],
        tabOrder: [],
        activeId: "a",
        settings: {},
      }),
    );
    const store = new Store(storage);
    expect(store.notes()).toHaveLength(1);
    expect(store.notes()[0].id).toBe("a");
    expect(store.doc.tabOrder).toContain("a");
  });

  it("drops ghost and closed ids from the tab order", () => {
    const storage = memoryStorage();
    storage.setItem(
      "mote.doc.v1",
      JSON.stringify({
        version: 1,
        notes: [
          { id: "a", title: "a", body: "a", createdAt: 1, updatedAt: 1 },
          { id: "b", title: "b", body: "b", createdAt: 2, updatedAt: 2, closedAt: 9 },
        ],
        tabOrder: ["a", "ghost", "b", "a"],
        activeId: "ghost",
        settings: {},
      }),
    );
    const store = new Store(storage);
    expect(store.doc.tabOrder).toEqual(["a"]);
    expect(store.notes().map((note) => note.id)).toEqual(["a"]);
    expect(store.doc.activeId).toBe("a");
  });

  it("seeds a fresh note when every stored note is closed", () => {
    const storage = memoryStorage();
    storage.setItem(
      "mote.doc.v1",
      JSON.stringify({
        version: 1,
        notes: [
          { id: "a", title: "a", body: "a", createdAt: 1, updatedAt: 1, closedAt: 9 },
        ],
        tabOrder: ["a"],
        activeId: "a",
        settings: {},
      }),
    );
    const store = new Store(storage);
    expect(store.notes()).toHaveLength(1);
    expect(store.doc.tabOrder).toHaveLength(1);
    expect(store.active()?.closedAt).toBeUndefined();
    expect(store.trashed()).toHaveLength(1);
  });

  it("lists trashed notes newest first", () => {
    const store = new Store(memoryStorage());
    const first = store.notes()[0];
    store.close(first.id);
    const second = store.create("second");
    store.close(second.id);

    store.doc.notes.find((note) => note.id === first.id)!.closedAt = 1000;
    store.doc.notes.find((note) => note.id === second.id)!.closedAt = 2000;

    const trashed = store.trashed();
    expect(trashed).toHaveLength(2);
    expect(trashed[0].id).toBe(second.id);
    expect(trashed[1].id).toBe(first.id);
  });

  it("permanently deletes only trashed notes", () => {
    const store = new Store(memoryStorage());
    const open = store.notes()[0];
    store.deleteForever(open.id);
    expect(store.doc.notes).toHaveLength(1);

    store.close(open.id);
    store.deleteForever(open.id);
    expect(store.doc.notes.some((note) => note.id === open.id)).toBe(false);
  });

  it("empties the trash without touching open notes", () => {
    const storage = memoryStorage();
    const store = new Store(storage);
    const open = store.create("keep me");
    const victim = store.notes()[0];
    store.close(victim.id);

    store.emptyTrash();

    expect(store.trashed()).toHaveLength(0);
    expect(store.doc.notes).toHaveLength(1);
    expect(store.doc.notes[0].id).toBe(open.id);

    const reloaded = new Store(storage);
    expect(reloaded.trashed()).toHaveLength(0);
    expect(reloaded.notes()[0].id).toBe(open.id);
  });

  it("pins and unpins open notes only", () => {
    const store = new Store(memoryStorage());
    const note = store.notes()[0];
    expect(store.togglePin(note.id)).toBe(true);
    expect(store.isPinned(note.id)).toBe(true);
    expect(store.togglePin(note.id)).toBe(false);
    expect(store.isPinned(note.id)).toBe(false);

    store.close(note.id);
    expect(store.togglePin(note.id)).toBe(false);
    expect(store.isPinned(note.id)).toBe(false);
  });

  it("unpins a note when it is trashed", () => {
    const storage = memoryStorage();
    const store = new Store(storage);
    const note = store.create("pin me");
    store.togglePin(note.id);
    store.close(note.id);
    expect(store.isPinned(note.id)).toBe(false);

    const reloaded = new Store(storage);
    expect(reloaded.doc.settings.pinnedIds).not.toContain(note.id);
  });

  it("drops stale pinned ids on load", () => {
    const storage = memoryStorage();
    storage.setItem(
      "mote.doc.v1",
      JSON.stringify({
        version: 1,
        notes: [{ id: "a", title: "a", body: "a", createdAt: 1, updatedAt: 1 }],
        tabOrder: ["a"],
        activeId: "a",
        settings: { pinnedIds: ["a", "ghost"] },
      }),
    );
    const store = new Store(storage);
    expect(store.doc.settings.pinnedIds).toEqual(["a"]);
  });
});
