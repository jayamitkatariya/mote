import type { Attachment, Doc, Note, NoteColor, Settings } from "./types";
import { isNoteColor } from "./colors";
import { parseTags } from "./tags";
import { togglePinId } from "./pins";

export const LEGACY_KEY = "mote.doc.v1";
export const DOC_VERSION = 2 as const;
const SAVE_DELAY = 250;

export const defaultSettings: Settings = {
  shakeEnabled: true,
  shakeSensitivity: 3,
  hideOnBlur: true,
  pinnedIds: [],
  stickyOpacity: 0.96,
};

export interface DocPersistence {
  load(): Promise<unknown | null>;
  save(doc: Doc): Promise<void>;
}

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
    tags: parseTags(body),
    attachments: [],
  };
}

const WELCOME = `welcome to mote

⌥M or a quick shake summons this window.

• ⌘K — search notes, tags, and commands
• ⌘N — new note
• #tag — organize notes by tag
• drop images right onto a note

everything saves itself, right on this mac.`;

export function welcomeDoc(): Doc {
  const note = createNote(WELCOME);
  return {
    version: DOC_VERSION,
    notes: [note],
    tabOrder: [note.id],
    activeId: note.id,
    settings: { ...defaultSettings },
  };
}

function isAttachment(value: unknown): value is Attachment {
  if (!value || typeof value !== "object") return false;
  const attachment = value as Record<string, unknown>;
  return (
    typeof attachment.id === "string" &&
    typeof attachment.name === "string" &&
    typeof attachment.ext === "string" &&
    typeof attachment.size === "number" &&
    typeof attachment.createdAt === "number"
  );
}

function clampNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

function coerceNote(value: unknown): Note | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  if (typeof raw.body !== "string") return null;
  const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now();
  const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : updatedAt;
  const title =
    typeof raw.title === "string" && raw.title.trim().length > 0
      ? raw.title
      : deriveTitle(raw.body) || "Untitled";
  const tags = parseTags(raw.body);
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments.filter(isAttachment)
    : [];
  return {
    id: raw.id,
    title,
    body: raw.body,
    createdAt,
    updatedAt,
    closedAt: typeof raw.closedAt === "number" ? raw.closedAt : undefined,
    color: isNoteColor(raw.color) ? raw.color : undefined,
    tags,
    attachments,
  };
}

export function normalizeNotes(raw: unknown): Note[] {
  if (!raw || typeof raw !== "object") return [];
  const notes = (raw as Record<string, unknown>).notes;
  if (!Array.isArray(notes)) return [];
  const seen = new Set<string>();
  const result: Note[] = [];
  for (const value of notes) {
    const note = coerceNote(value);
    if (!note || seen.has(note.id)) continue;
    seen.add(note.id);
    result.push(note);
  }
  return result;
}

export function normalizeDoc(raw: unknown): Doc | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const notes = normalizeNotes(raw);
  if (notes.length === 0) return null;

  const inputSettings =
    input.settings && typeof input.settings === "object"
      ? (input.settings as Record<string, unknown>)
      : {};
  const settings: Settings = {
    ...defaultSettings,
    shakeEnabled:
      typeof inputSettings.shakeEnabled === "boolean"
        ? inputSettings.shakeEnabled
        : defaultSettings.shakeEnabled,
    shakeSensitivity:
      clampNumber(inputSettings.shakeSensitivity, 1, 5) ?? defaultSettings.shakeSensitivity,
    hideOnBlur:
      typeof inputSettings.hideOnBlur === "boolean"
        ? inputSettings.hideOnBlur
        : defaultSettings.hideOnBlur,
    pinnedIds: Array.isArray(inputSettings.pinnedIds)
      ? inputSettings.pinnedIds.filter((id): id is string => typeof id === "string")
      : [],
    stickyOpacity:
      clampNumber(inputSettings.stickyOpacity, 0.35, 1) ?? defaultSettings.stickyOpacity,
  };
  settings.pinnedIds = settings.pinnedIds.filter((id) =>
    notes.some((note) => note.id === id && !note.closedAt),
  );

  const openIds = new Set(notes.filter((note) => !note.closedAt).map((note) => note.id));
  let tabOrder = Array.isArray(input.tabOrder)
    ? [...new Set(input.tabOrder.filter((id): id is string => typeof id === "string"))].filter(
        (id) => openIds.has(id),
      )
    : [];
  let activeId = typeof input.activeId === "string" ? input.activeId : null;

  if (tabOrder.length === 0) {
    if (openIds.size === 0) {
      const fresh = createNote();
      notes.push(fresh);
      tabOrder = [fresh.id];
      activeId = fresh.id;
    } else {
      tabOrder = notes.filter((note) => !note.closedAt).map((note) => note.id);
    }
  }
  if (activeId === null || !tabOrder.includes(activeId)) activeId = tabOrder[0] ?? null;

  return { version: DOC_VERSION, notes, tabOrder, activeId, settings };
}

function cloneDoc(doc: Doc): Doc {
  return JSON.parse(JSON.stringify(doc)) as Doc;
}

export class Store {
  doc: Doc;
  lastError: unknown = null;
  onPersistError: ((error: unknown) => void) | null = null;
  onPersisted: (() => void) | null = null;

  private persistence: DocPersistence;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(doc: Doc, persistence: DocPersistence) {
    this.doc = doc;
    this.persistence = persistence;
  }

  static async open(persistence: DocPersistence): Promise<Store> {
    const raw = await persistence.load();
    const normalized = raw == null ? null : normalizeDoc(raw);
    const store = new Store(normalized ?? welcomeDoc(), persistence);
    await store.enqueue();
    return store;
  }

  private enqueue(): Promise<void> {
    const snapshot = cloneDoc(this.doc);
    this.chain = this.chain.then(async () => {
      try {
        await this.persistence.save(snapshot);
        this.lastError = null;
        this.onPersisted?.();
      } catch (error) {
        this.lastError = error;
        this.onPersistError?.(error);
      }
    });
    return this.chain;
  }

  save(immediate = false) {
    if (immediate) {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      void this.enqueue();
      return;
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueue();
    }, SAVE_DELAY);
  }

  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.enqueue();
  }

  notes(): Note[] {
    return this.doc.tabOrder
      .map((id) => this.doc.notes.find((note) => note.id === id))
      .filter((note): note is Note => Boolean(note));
  }

  active(): Note | null {
    return this.doc.notes.find((note) => note.id === this.doc.activeId) ?? null;
  }

  find(id: string): Note | null {
    return this.doc.notes.find((note) => note.id === id) ?? null;
  }

  create(body = ""): Note {
    const note = createNote(body);
    this.doc.notes.push(note);
    this.doc.tabOrder.push(note.id);
    this.doc.activeId = note.id;
    this.save(true);
    return note;
  }

  duplicate(id: string): Note | null {
    const source = this.find(id);
    if (!source || source.closedAt) return null;
    const copy = createNote(source.body);
    copy.color = source.color;
    this.doc.notes.push(copy);
    const index = this.doc.tabOrder.indexOf(id);
    this.doc.tabOrder.splice(index === -1 ? this.doc.tabOrder.length : index + 1, 0, copy.id);
    this.doc.activeId = copy.id;
    this.save(true);
    return copy;
  }

  sortTabsByRecent() {
    const updated = new Map(this.doc.notes.map((note) => [note.id, note.updatedAt]));
    this.doc.tabOrder.sort((a, b) => (updated.get(b) ?? 0) - (updated.get(a) ?? 0));
    this.save(true);
  }

  close(id: string) {
    const index = this.doc.tabOrder.indexOf(id);
    if (index === -1) return;
    this.doc.tabOrder.splice(index, 1);
    const note = this.find(id);
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
    const note = this.find(id);
    if (!note) return;
    if (!this.doc.tabOrder.includes(id)) this.doc.tabOrder.push(id);
    note.closedAt = undefined;
    this.doc.activeId = id;
    this.save(true);
  }

  updateBody(id: string, body: string) {
    const note = this.find(id);
    if (!note) return;
    note.body = body;
    note.title = deriveTitle(body) || "Untitled";
    note.tags = parseTags(body);
    note.updatedAt = Date.now();
    this.save();
  }

  setColor(id: string, color: NoteColor | undefined) {
    const note = this.find(id);
    if (!note) return;
    note.color = color;
    note.updatedAt = Date.now();
    this.save(true);
  }

  addAttachment(id: string, attachment: Attachment) {
    const note = this.find(id);
    if (!note) return;
    if (note.attachments.some((value) => value.id === attachment.id)) return;
    note.attachments.push(attachment);
    note.updatedAt = Date.now();
    this.save(true);
  }

  removeAttachment(id: string, attachmentId: string) {
    const note = this.find(id);
    if (!note) return;
    note.attachments = note.attachments.filter((value) => value.id !== attachmentId);
    note.updatedAt = Date.now();
    this.save(true);
  }

  referencedAttachmentIds(): string[] {
    const ids = new Set<string>();
    for (const note of this.doc.notes) {
      for (const attachment of note.attachments) ids.add(attachment.id);
    }
    return [...ids];
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

  importNotes(raw: unknown): number {
    const incoming = normalizeNotes(raw);
    if (incoming.length === 0) return 0;
    const existing = new Set(this.doc.notes.map((note) => note.id));
    let added = 0;
    for (const note of incoming) {
      if (existing.has(note.id)) continue;
      existing.add(note.id);
      note.attachments = [];
      this.doc.notes.push(note);
      added += 1;
      if (note.closedAt) continue;
      this.doc.tabOrder.push(note.id);
      if (this.doc.activeId === null) this.doc.activeId = note.id;
    }
    if (added > 0) this.save(true);
    return added;
  }

  isPinned(id: string): boolean {
    return this.doc.settings.pinnedIds.includes(id);
  }

  togglePin(id: string): boolean {
    const note = this.find(id);
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
