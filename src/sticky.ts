import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { History } from "./history";
import { noteIdFromLabel } from "./pins";
import { api, type DocChangedPayload, type SettingsChangedPayload } from "./tauri";
import type { Doc, Note, NoteColor } from "./types";

const appWindow = getCurrentWindow();
const noteId = noteIdFromLabel(appWindow.label);

const paperclip = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.8 4.2 5.6 8.4a2 2 0 0 0 2.8 2.8l4.4-4.4a3.3 3.3 0 0 0-4.7-4.7L3.4 6.8a4.6 4.6 0 0 0 6.5 6.5l3.9-3.9"/></svg>`;

function pick<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing element ${selector}`);
  return element;
}

function findNote(raw: unknown, id: string): { note: Note | null; opacity: number } {
  const doc = raw as Partial<Doc> | null;
  const note = doc?.notes?.find((value) => value.id === id) ?? null;
  const opacity =
    typeof doc?.settings?.stickyOpacity === "number" ? doc.settings.stickyOpacity : 0.96;
  return { note, opacity };
}

function mount(note: Note, opacity: number) {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) return;
  document.body.classList.add("sticky-body");
  root.innerHTML = `
    <div class="sticky-shell" id="sticky-shell">
      <header class="sticky-head" data-tauri-drag-region>
        <span class="sticky-dot" id="sticky-dot"></span>
        <span class="sticky-title" id="sticky-title">untitled</span>
        <span class="sticky-attachments" id="sticky-attachments" hidden>${paperclip}<span id="sticky-attachment-count">0</span></span>
        <button class="icon-button" id="sticky-close" title="Unpin note">
          <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      </header>
      <textarea id="sticky-editor" class="sticky-editor" spellcheck="true" placeholder="start typing…"></textarea>
    </div>
  `;

  const shell = pick<HTMLDivElement>("#sticky-shell");
  const editor = pick<HTMLTextAreaElement>("#sticky-editor");
  const titleEl = pick<HTMLSpanElement>("#sticky-title");
  const dotEl = pick<HTMLSpanElement>("#sticky-dot");
  const attachmentEl = pick<HTMLSpanElement>("#sticky-attachments");
  const attachmentCountEl = pick<HTMLSpanElement>("#sticky-attachment-count");

  const history = new History();
  let timer: number | undefined;
  let saving = false;

  history.reset(note.id, { body: note.body, start: note.body.length, end: note.body.length });

  function setColor(color: NoteColor | undefined) {
    if (color) shell.dataset.color = color;
    else delete shell.dataset.color;
  }

  function setOpacity(value: number) {
    shell.style.setProperty("--sticky-opacity", String(value));
  }

  function setAttachments(count: number) {
    attachmentEl.hidden = count === 0;
    attachmentCountEl.textContent = String(count);
  }

  function setSaving(next: boolean) {
    saving = next;
    dotEl.classList.toggle("is-saving", next);
  }

  function send(body: string, immediate = false) {
    if (timer) clearTimeout(timer);
    setSaving(true);
    const flush = () => {
      timer = undefined;
      void emit("mote://sticky-edit", { id: note.id, body });
    };
    if (immediate) flush();
    else timer = window.setTimeout(flush, 150);
  }

  editor.addEventListener("input", () => {
    history.record(note.id, {
      body: editor.value,
      start: editor.selectionStart,
      end: editor.selectionEnd,
    });
    send(editor.value);
  });

  editor.addEventListener("keydown", (event) => {
    if (
      event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      event.key.toLowerCase() === "z"
    ) {
      event.preventDefault();
      const snapshot = event.shiftKey ? history.redo(note.id) : history.undo(note.id);
      if (!snapshot) return;
      editor.value = snapshot.body;
      const max = snapshot.body.length;
      editor.setSelectionRange(Math.min(snapshot.start, max), Math.min(snapshot.end, max));
      send(snapshot.body, true);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.setRangeText("  ", start, end, "end");
      editor.dispatchEvent(new Event("input"));
      return;
    }
    if (event.metaKey && event.key.toLowerCase() === "w") {
      event.preventDefault();
      void appWindow.close();
      return;
    }
    if (event.key === "Escape") {
      editor.blur();
    }
  });

  document.querySelector("#sticky-close")?.addEventListener("click", () => {
    void appWindow.close();
  });

  void listen<DocChangedPayload>("mote://doc-changed", (event) => {
    const payload = event.payload;
    if (payload.id !== note.id) return;
    titleEl.textContent = payload.title || "Untitled";
    document.title = payload.title || "Mote";
    setColor(payload.color);
    setOpacity(payload.opacity);
    setAttachments(payload.attachmentCount);
    if (document.activeElement !== editor && editor.value !== payload.body) {
      editor.value = payload.body;
      history.reset(note.id, {
        body: payload.body,
        start: payload.body.length,
        end: payload.body.length,
      });
    }
    if (saving) setSaving(false);
  });

  void listen<SettingsChangedPayload>("mote://settings-changed", (event) => {
    setOpacity(event.payload.opacity);
  });

  titleEl.textContent = note.title || "Untitled";
  document.title = note.title || "Mote";
  editor.value = note.body;
  setColor(note.color);
  setOpacity(opacity);
  setAttachments(note.attachments?.length ?? 0);
  editor.focus();
  void emit("mote://sticky-ready", note.id);
}

if (noteId) {
  void (async () => {
    try {
      const raw = await api.loadDoc();
      const { note, opacity } = findNote(raw, noteId);
      if (!note || note.closedAt) {
        void appWindow.close();
        return;
      }
      mount(note, opacity);
    } catch (error) {
      console.error("mote: could not open the sticky note", error);
      void appWindow.close();
    }
  })();
} else {
  void appWindow.close();
}
