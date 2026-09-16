import { describe, expect, it } from "vitest";
import { deriveTitle, Store, type DocPersistence } from "./store";
import type { Doc } from "./types";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function memoryPersistence(initial: unknown = null): {
  persistence: DocPersistence;
  read: () => unknown;
} {
  let stored: unknown = initial === null ? null : clone(initial);
  return {
    persistence: {
      load: async () => stored,
      save: async (doc: Doc) => {
        stored = clone(doc);
      },
    },
    read: () => stored,
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
  it("seeds a welcome note on first run", async () => {
    const { persistence } = memoryPersistence();
    const store = await Store.open(persistence);
    expect(store.notes()).toHaveLength(1);
    expect(store.active()?.body).toContain("welcome to mote");
  });

  it("persists notes across instances", async () => {
    const { persistence } = memoryPersistence();
    const first = await Store.open(persistence);
    const note = first.create("persisted note");
    first.updateBody(note.id, "persisted note\nwith more text");
    await first.flush();

    const second = await Store.open(persistence);
    const restored = second.notes().find((value) => value.id === note.id);
    expect(restored?.body).toBe("persisted note\nwith more text");
    expect(restored?.title).toBe("persisted note");
  });

  it("writes the document on first open", async () => {
    const { persistence, read } = memoryPersistence();
    await Store.open(persistence);
    const doc = read() as Doc;
    expect(doc.version).toBe(2);
    expect(doc.notes).toHaveLength(1);
  });

  it("archives the last note instead of deleting it", async () => {
    const { persistence } = memoryPersistence();
    const store = await Store.open(persistence);
    const id = store.notes()[0].id;
    store.close(id);
    expect(store.notes()).toHaveLength(1);
    expect(store.notes()[0].id).not.toBe(id);
    expect(store.doc.notes).toHaveLength(2);

    const archived = store.doc.notes.find((note) => note.id === id);
    expect(archived?.closedAt).toBeTypeOf("number");
  });

  it("reopens a closed note from search", async () => {
    const { persistence } = memoryPersistence();
    const store = await Store.open(persistence);
    const id = store.notes()[0].id;
    store.close(id);
    store.open(id);

    expect(store.doc.tabOrder).toContain(id);
    expect(store.doc.activeId).toBe(id);
    const reopened = store.doc.notes.find((note) => note.id === id);
    expect(reopened?.closedAt).toBeUndefined();
  });

  it("moves selection after closing the active tab", async () => {
    const { persistence } = memoryPersistence();
    const store = await Store.open(persistence);
    const second = store.create("second");
    const third = store.create("third");
    store.open(second.id);
    store.close(second.id);
    expect(store.doc.activeId).toBe(third.id);
    expect(store.doc.notes.some((note) => note.id === second.id)).toBe(true);
  });

  it("recovers from corrupted storage", async () => {
    const store = await Store.open({
      load: async () => "{not json",
      save: async () => {},
    });
    expect(store.notes().length).toBeGreaterThan(0);
  });

  it("merges missing settings with defaults", async () => {
    const store = await Store.open({
      load: async () => ({
        version: 1,
        notes: [{ id: "a", title: "a", body: "a", createdAt: 1, updatedAt: 1 }],
        tabOrder: ["a"],
        activeId: "a",
        settings: { shakeEnabled: false },
      }),
      save: async () => {},
    });
    expect(store.doc.settings.shakeEnabled).toBe(false);
    expect(store.doc.settings.shakeSensitivity).toBe(3);
    expect(store.doc.settings.hideOnBlur).toBe(true);
    expect(store.doc.settings.stickyOpacity).toBe(0.96);
  });

  it("reseeds the welcome note when storage has no notes", async () => {
    const store = await Store.open({
      load: async () => ({ version: 1, notes: [], tabOrder: [], activeId: null, settings: {} }),
      save: async () => {},
    });
    expect(store.notes()).toHaveLength(1);
    expect(store.active()?.body).toContain("welcome to mote");
  });

  it("restores the active note into the tab order", async () => {
    const store = await Store.open({
      load: async () => ({
        version: 1,
        notes: [{ id: "a", title: "a", body: "a", createdAt: 1, updatedAt: 1 }],
        tabOrder: [],
        activeId: "a",
        settings: {},
      }),
      save: async () => {},
    });
    expect(store.notes()).toHaveLength(1);
    expect(store.notes()[0].id).toBe("a");
    expect(store.doc.tabOrder).toContain("a");
  });

  it("drops ghost and closed ids from the tab order", async () => {
    const store = await Store.open({
      load: async () => ({
        version: 1,
        notes: [
          { id: "a", title: "a", body: "a", createdAt: 1, updatedAt: 1 },
          { id: "b", title: "b", body: "b", createdAt: 2, updatedAt: 2, closedAt: 9 },
        ],
        tabOrder: ["a", "ghost", "b", "a"],
        activeId: "ghost",
        settings: {},
      }),
      save: async () => {},
    });
    expect(store.doc.tabOrder).toEqual(["a"]);
    expect(store.notes().map((note) => note.id)).toEqual(["a"]);
    expect(store.doc.activeId).toBe("a");
  });

  it("seeds a fresh note when every stored note is closed", async () => {
    const store = await Store.open({
      load: async () => ({
        version: 1,
        notes: [{ id: "a", title: "a", body: "a", createdAt: 1, updatedAt: 1, closedAt: 9 }],
        tabOrder: ["a"],
        activeId: "a",
        settings: {},
      }),
      save: async () => {},
    });
    expect(store.notes()).toHaveLength(1);
    expect(store.doc.tabOrder).toHaveLength(1);
    expect(store.active()?.closedAt).toBeUndefined();
    expect(store.trashed()).toHaveLength(1);
  });

  it("lists trashed notes newest first", async () => {
    const { persistence } = memoryPersistence();
    const store = await Store.open(persistence);
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

  it("permanently deletes only trashed notes", async () => {
    const { persistence } = memoryPersistence();
    const store = await Store.open(persistence);
    const open = store.notes()[0];
    store.deleteForever(open.id);
    expect(store.doc.notes).toHaveLength(1);

    store.close(open.id);
    store.deleteForever(open.id);
    expect(store.doc.notes.some((note) => note.id === open.id)).toBe(false);
  });

  it("empties the trash without touching open notes", async () => {
    const { persistence } = memoryPersistence();
    const store = await Store.open(persistence);
    const open = store.create("keep me");
    const victim = store.notes()[0];
    store.close(victim.id);

    store.emptyTrash();

    expect(store.trashed()).toHaveLength(0);
    expect(store.doc.notes).toHaveLength(1);
    expect(store.doc.notes[0].id).toBe(open.id);

    await store.flush();
    const reloaded = await Store.open(persistence);
    expect(reloaded.trashed()).toHaveLength(0);
    expect(reloaded.notes()[0].id).toBe(open.id);
  });

  it("pins and unpins open notes only", async () => {
    const { persistence } = memoryPersistence();
    const store = await Store.open(persistence);
    const note = store.notes()[0];
    expect(store.togglePin(note.id)).toBe(true);
    expect(store.isPinned(note.id)).toBe(true);
    expect(store.togglePin(note.id)).toBe(false);
    expect(store.isPinned(note.id)).toBe(false);

    store.close(note.id);
    expect(store.togglePin(note.id)).toBe(false);
    expect(store.isPinned(note.id)).toBe(false);
  });

  it("unpins a note when it is trashed", async () => {
    const { persistence } = memoryPersistence();
    const store = await Store.open(persistence);
    const note = store.create("pin me");
    store.togglePin(note.id);
    store.close(note.id);
    expect(store.isPinned(note.id)).toBe(false);

    await store.flush();
    const reloaded = await Store.open(persistence);
    expect(reloaded.doc.settings.pinnedIds).not.toContain(note.id);
  });

  it("drops stale pinned ids on load", async () => {
    const store = await Store.open({
      load: async () => ({
        version: 1,
        notes: [{ id: "a", title: "a", body: "a", createdAt: 1, updatedAt: 1 }],
        tabOrder: ["a"],
        activeId: "a",
        settings: { pinnedIds: ["a", "ghost"] },
      }),
      save: async () => {},
    });
    expect(store.doc.settings.pinnedIds).toEqual(["a"]);
  });

  it("migrates v1 notes without losing content", async () => {
    const legacy = {
      version: 1,
      notes: [
        {
          id: "a",
          title: "TTD :",
          body: "TTD :\n#work #urgent",
          createdAt: 1,
          updatedAt: 2,
        },
        { id: "b", title: "Old thought", body: "Old thought", createdAt: 3, updatedAt: 4, closedAt: 9 },
      ],
      tabOrder: ["a"],
      activeId: "a",
      settings: { shakeEnabled: false, shakeSensitivity: 5, hideOnBlur: false, pinnedIds: [] },
    };
    const store = await Store.open({ load: async () => legacy, save: async () => {} });
    const note = store.find("a")!;
    expect(store.doc.version).toBe(2);
    expect(note.id).toBe("a");
    expect(note.title).toBe("TTD :");
    expect(note.body).toBe("TTD :\n#work #urgent");
    expect(note.tags).toEqual(["work", "urgent"]);
    expect(note.attachments).toEqual([]);
    expect(store.find("b")?.closedAt).toBe(9);
    expect(store.doc.settings.shakeSensitivity).toBe(5);
    expect(store.doc.settings.shakeEnabled).toBe(false);
    expect(store.doc.settings.stickyOpacity).toBe(0.96);
  });

  it("dedupes notes and recomputes tags while loading", async () => {
    const store = await Store.open({
      load: async () => ({
        version: 2,
        notes: [
          { id: "a", title: "a", body: "one #first", createdAt: 1, updatedAt: 1 },
          { id: "a", title: "dupe", body: "dupe", createdAt: 1, updatedAt: 1 },
          { id: "b", body: "#TAG and #tag and #other", createdAt: 1, updatedAt: 1, tags: [] },
        ],
        tabOrder: ["a", "b"],
        activeId: "a",
        settings: {},
      }),
      save: async () => {},
    });
    expect(store.doc.notes).toHaveLength(2);
    expect(store.find("a")?.tags).toEqual(["first"]);
    expect(store.find("b")?.tags).toEqual(["tag", "other"]);
    expect(store.find("b")?.title).toBe("TAG and #tag and #other");
    expect(store.find("b")?.body).toBe("#TAG and #tag and #other");
  });

  it("tracks referenced attachments across open and trashed notes", async () => {
    const { persistence } = memoryPersistence();
    const store = await Store.open(persistence);
    const note = store.notes()[0];
    store.addAttachment(note.id, {
      id: "hash1",
      name: "photo.png",
      ext: "png",
      size: 10,
      createdAt: 1,
    });
    const second = store.create("second");
    store.addAttachment(second.id, {
      id: "hash2",
      name: "image.jpg",
      ext: "jpg",
      size: 20,
      createdAt: 2,
    });
    store.close(second.id);
    expect(store.referencedAttachmentIds().sort()).toEqual(["hash1", "hash2"]);

    store.removeAttachment(note.id, "hash1");
    expect(store.referencedAttachmentIds()).toEqual(["hash2"]);
  });

  it("imports new notes, skips duplicates, and strips attachments", async () => {
    const { persistence } = memoryPersistence();
    const store = await Store.open(persistence);
    const existing = store.notes()[0].id;
    const added = store.importNotes({
      notes: [
        { id: existing, title: "same", body: "same", createdAt: 1, updatedAt: 1 },
        {
          id: "fresh",
          title: "fresh",
          body: "fresh #tag",
          createdAt: 2,
          updatedAt: 2,
          attachments: [{ id: "stale", name: "x.png", ext: "png", size: 1, createdAt: 1 }],
        },
      ],
    });
    expect(added).toBe(1);
    expect(store.doc.notes).toHaveLength(2);
    const fresh = store.find("fresh")!;
    expect(fresh.tags).toEqual(["tag"]);
    expect(fresh.attachments).toEqual([]);
    expect(store.doc.tabOrder).toContain("fresh");
  });

  it("duplicates a note with color but not attachments", async () => {
    const { persistence } = memoryPersistence();
    const store = await Store.open(persistence);
    const note = store.notes()[0];
    store.setColor(note.id, "blue");
    store.addAttachment(note.id, {
      id: "hash1",
      name: "photo.png",
      ext: "png",
      size: 10,
      createdAt: 1,
    });
    const copy = store.duplicate(note.id)!;
    expect(copy.id).not.toBe(note.id);
    expect(copy.body).toBe(note.body);
    expect(copy.color).toBe("blue");
    expect(copy.attachments).toEqual([]);
    expect(store.doc.tabOrder.indexOf(copy.id)).toBe(store.doc.tabOrder.indexOf(note.id) + 1);
  });

  it("sorts tabs by most recently updated", async () => {
    const { persistence } = memoryPersistence();
    const store = await Store.open(persistence);
    const first = store.notes()[0];
    const second = store.create("second");
    store.updateBody(first.id, "changed first");
    store.sortTabsByRecent();
    expect(store.doc.tabOrder[0]).toBe(first.id);
    expect(store.doc.tabOrder[1]).toBe(second.id);
  });

  it("records save failures without throwing", async () => {
    const store = await Store.open({
      load: async () => null,
      save: async () => {
        throw new Error("disk full");
      },
    });
    expect(store.lastError).toBeInstanceOf(Error);
    await expect(store.flush()).resolves.toBeUndefined();
  });
});
