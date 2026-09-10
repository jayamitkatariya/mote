export interface Snapshot {
  body: string;
  start: number;
  end: number;
}

export interface RecordOptions {
  coalesceMs?: number;
  now?: number;
}

interface NoteHistory {
  entries: Snapshot[];
  index: number;
  recordedAt: number;
}

export const DEFAULT_COALESCE_MS = 600;
const DEFAULT_LIMIT = 200;

export class History {
  private notes = new Map<string, NoteHistory>();
  private limit: number;

  constructor(limit = DEFAULT_LIMIT) {
    this.limit = Math.max(2, limit);
  }

  has(id: string): boolean {
    return this.notes.has(id);
  }

  reset(id: string, snapshot: Snapshot) {
    this.notes.set(id, { entries: [{ ...snapshot }], index: 0, recordedAt: 0 });
  }

  record(id: string, snapshot: Snapshot, options: RecordOptions = {}) {
    const { coalesceMs = DEFAULT_COALESCE_MS, now = Date.now() } = options;
    const next = { ...snapshot };
    const state = this.notes.get(id);
    if (!state) {
      this.notes.set(id, { entries: [next], index: 0, recordedAt: now });
      return;
    }

    const top = state.entries[state.index];
    if (top && top.body === next.body) {
      top.start = next.start;
      top.end = next.end;
      return;
    }

    if (state.index < state.entries.length - 1) {
      state.entries.length = state.index + 1;
    }

    if (coalesceMs > 0 && now - state.recordedAt < coalesceMs) {
      state.entries[state.index] = next;
    } else {
      state.entries.push(next);
      if (state.entries.length > this.limit) state.entries.shift();
    }
    state.index = state.entries.length - 1;
    state.recordedAt = now;
  }

  canUndo(id: string): boolean {
    const state = this.notes.get(id);
    return Boolean(state && state.index > 0);
  }

  canRedo(id: string): boolean {
    const state = this.notes.get(id);
    return Boolean(state && state.index < state.entries.length - 1);
  }

  undo(id: string): Snapshot | null {
    const state = this.notes.get(id);
    if (!state || state.index <= 0) return null;
    state.index -= 1;
    state.recordedAt = 0;
    return { ...state.entries[state.index] };
  }

  redo(id: string): Snapshot | null {
    const state = this.notes.get(id);
    if (!state || state.index >= state.entries.length - 1) return null;
    state.index += 1;
    state.recordedAt = 0;
    return { ...state.entries[state.index] };
  }

  discard(id: string) {
    this.notes.delete(id);
  }
}
