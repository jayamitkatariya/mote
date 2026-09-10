import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { noteIdFromLabel } from "./pins";
import type { Doc, Note } from "./types";

const KEY = "mote.doc.v1";

interface DocChangedPayload {
  id: string;
  title: string;
  body: string;
}

function readNote(noteId: string): Note | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const doc = JSON.parse(raw) as Doc;
    return doc.notes.find((note) => note.id === noteId) ?? null;
  } catch {
    return null;
  }
}

const appWindow = getCurrentWindow();
const noteId = noteIdFromLabel(appWindow.label);

function mount(id: string) {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) return;
  document.body.classList.add("sticky-body");
  root.innerHTML = `
    <div class="sticky-shell">
      <header class="sticky-head" data-tauri-drag-region>
        <span class="sticky-dot" id="sticky-dot"></span>
        <span class="sticky-title" id="sticky-title">untitled</span>
        <button class="icon-button" id="sticky-close" title="Unpin note">
          <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      </header>
      <textarea id="sticky-editor" class="sticky-editor" spellcheck="true" placeholder="start typing…"></textarea>
    </div>
  `;

  const editor = document.querySelector<HTMLTextAreaElement>("#sticky-editor");
  const titleEl = document.querySelector<HTMLSpanElement>("#sticky-title");
  const dotEl = document.querySelector<HTMLSpanElement>("#sticky-dot");
  if (!editor || !titleEl || !dotEl) return;
  const dot = dotEl;

  let timer: number | undefined;

  function setSaving(saving: boolean) {
    dot.classList.toggle("is-saving", saving);
  }

  editor.addEventListener("input", () => {
    if (timer) clearTimeout(timer);
    setSaving(true);
    timer = window.setTimeout(() => {
      void emit("mote://sticky-edit", { id, body: editor.value });
    }, 150);
  });

  editor.addEventListener("keydown", (event) => {
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
    if (payload.id !== id) return;
    titleEl.textContent = payload.title || "Untitled";
    document.title = payload.title || "Mote";
    if (document.activeElement !== editor && editor.value !== payload.body) {
      editor.value = payload.body;
    }
    setSaving(false);
  });

  const note = readNote(id);
  if (!note || note.closedAt) {
    void appWindow.close();
    return;
  }

  titleEl.textContent = note.title || "Untitled";
  document.title = note.title || "Mote";
  editor.value = note.body;
  editor.focus();
  void emit("mote://sticky-ready", id);
}

if (noteId) {
  mount(noteId);
} else {
  void appWindow.close();
}
