import type { Doc, Note, Settings } from "./types";
import { togglePinId } from "./pins";

const KEY = "mote.doc.v1";
const SAVE_DELAY = 250;

export const defaultSettings: Settings = {
  shakeEnabled: true,
  shakeSensitivity: 3,
  hideOnBlur: true,
  pinnedIds: [],
};

export function deriveTitle(body: string): string {
  const line = body.split("\n").find((value) => value.trim().length > 0) ?? "";
  const cleaned = line.replace(/^[#>\-*\s]+/, "").trim();
  if (!cleaned) return "";
  return cleaned.length > 48 ? `${cleaned.slice(0, 47)}…` : cleaned;
}

function createNote(body = ""): Note {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: deriveTitle(body) || "Untitled",
    body,
    createdAt: now,
    updatedAt: now,
  };
}

const WELCOME = `welcome to mote

⌥M or a quick shake summons this window.

• ⌘K — search every note and run commands
• ⌘N — new note
• ⌘W — close note
• esc — hide

everything saves itself, right on this mac.`;

function welcomeDoc(): Doc {
  const note = createNote(WELCOME);
  return {
    version: 1,
    notes: [note],
    tabOrder: [note.id],
    activeId: note.id,
    settings: { ...defaultSettings },
  };
}

function isNote(value: unknown): value is Note {
  if (!value || typeof value !== "object") return false;
  const note = value as Record<string, unknown>;
  return (
    typeof note.id === "string" &&
    typeof note.title === "string" &&
    typeof note.body === "string" &&
    typeof note.createdAt === "number" &&
    typeof note.updatedAt === "number"
  );
}

function isDoc(value: unknown): value is Doc {
  if (!value || typeof value !== "object") return false;
  const doc = value as Record<string, unknown>;
  return (
    doc.version === 1 &&
    Array.isArray(doc.notes) &&
    doc.notes.every(isNote) &&
    Array.isArray(doc.tabOrder) &&
    doc.tabOrder.every((id) => typeof id === "string")
  );
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class Store {
  doc: Doc;
  private storage: StorageLike;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(storage: StorageLike = localStorage) {
    this.storage = storage;
    this.doc = this.load();
  }

  private load(): Doc {
    try {
      const raw = this.storage.getItem(KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (isDoc(parsed)) {
          if (parsed.notes.length === 0) return welcomeDoc();
          parsed.settings = { ...defaultSettings, ...parsed.settings };
          if (!Array.isArray(parsed.settings.pinnedIds)) parsed.settings.pinnedIds = [];
          parsed.settings.pinnedIds = parsed.settings.pinnedIds.filter((id) =>
            parsed.notes.some((note) => note.id === id && !note.closedAt),
          );
          const openIds = new Set(
            parsed.notes.filter((note) => !note.closedAt).map((note) => note.id),
          );
          parsed.tabOrder = [...new Set(parsed.tabOrder)].filter((id) => openIds.has(id));
          if (parsed.tabOrder.length === 0) {
            if (openIds.size === 0) {
              const fresh = createNote();
              parsed.notes.push(fresh);
              parsed.tabOrder = [fresh.id];
              parsed.activeId = fresh.id;
              return parsed;
            }
            parsed.tabOrder = parsed.notes
              .filter((note) => !note.closedAt)
              .map((note) => note.id);
          }
          const activeId =
            parsed.activeId && parsed.tabOrder.includes(parsed.activeId)
              ? parsed.activeId
              : parsed.tabOrder[0];
          parsed.activeId = activeId;
          return parsed;
        }
      }
    } catch {
      return welcomeDoc();
    }
    return welcomeDoc();
  }

  save(immediate = false) {
    if (this.timer !== null) clearTimeout(this.timer);
    if (immediate) {
      this.timer = null;
      this.write();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, SAVE_DELAY);
  }

  flush() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.write();
  }

  private write() {
    try {
      this.storage.setItem(KEY, JSON.stringify(this.doc));
    } catch {
      return;
    }
  }

  notes(): Note[] {
    return this.doc.tabOrder
      .map((id) => this.doc.notes.find((note) => note.id === id))
      .filter((note): note is Note => Boolean(note));
  }

  active(): Note | null {
    return this.doc.notes.find((note) => note.id === this.doc.activeId) ?? null;
  }

  create(body = ""): Note {
    const note = createNote(body);
    this.doc.notes.push(note);
    this.doc.tabOrder.push(note.id);
    this.doc.activeId = note.id;
    this.save(true);
    return note;
  }

  close(id: string) {
    const index = this.doc.tabOrder.indexOf(id);
    if (index === -1) return;
    this.doc.tabOrder.splice(index, 1);
    const note = this.doc.notes.find((value) => value.id === id);
    if (note) note.closedAt = Date.now();
    this.doc.settings.pinnedIds = this.doc.settings.pinnedIds.filter((value) => value !== id);
    if (this.doc.tabOrder.length === 0) {
      const fresh = createNote();
      this.doc.notes.push(fresh);
      this.doc.tabOrder.push(fresh.id);
      this.doc.activeId = fresh.id;
    } else if (this.doc.activeId === id) {
      const next = Math.min(index, this.doc.tabOrder.length - 1);
      this.doc.activeId = this.doc.tabOrder[next];
    }
    this.save(true);
  }

  open(id: string) {
    const note = this.doc.notes.find((value) => value.id === id);
    if (!note) return;
    if (!this.doc.tabOrder.includes(id)) this.doc.tabOrder.push(id);
    note.closedAt = undefined;
    this.doc.activeId = id;
    this.save(true);
  }

  updateBody(id: string, body: string) {
    const note = this.doc.notes.find((value) => value.id === id);
    if (!note) return;
    note.body = body;
    note.title = deriveTitle(body) || "Untitled";
    note.updatedAt = Date.now();
    this.save();
  }

  trashed(): Note[] {
    return this.doc.notes
      .filter((note) => note.closedAt)
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  }

  deleteForever(id: string) {
    const index = this.doc.notes.findIndex((note) => note.id === id);
    if (index === -1) return;
    if (!this.doc.notes[index].closedAt) return;
    this.doc.notes.splice(index, 1);
    this.doc.settings.pinnedIds = this.doc.settings.pinnedIds.filter((value) => value !== id);
    this.save(true);
  }

  emptyTrash() {
    const remaining = this.doc.notes.filter((note) => !note.closedAt);
    if (remaining.length === this.doc.notes.length) return;
    this.doc.notes = remaining;
    this.doc.settings.pinnedIds = this.doc.settings.pinnedIds.filter((id) =>
      remaining.some((note) => note.id === id),
    );
    this.save(true);
  }

  isPinned(id: string): boolean {
    return this.doc.settings.pinnedIds.includes(id);
  }

  togglePin(id: string): boolean {
    const note = this.doc.notes.find((value) => value.id === id);
    if (!note || note.closedAt) return false;
    this.doc.settings.pinnedIds = togglePinId(this.doc.settings.pinnedIds, id);
    const pinned = this.doc.settings.pinnedIds.includes(id);
    this.save(true);
    return pinned;
  }

  unpin(id: string) {
    if (!this.doc.settings.pinnedIds.includes(id)) return;
    this.doc.settings.pinnedIds = togglePinId(this.doc.settings.pinnedIds, id);
    this.save(true);
  }

  setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    this.doc.settings[key] = value;
    this.save(true);
  }
}
