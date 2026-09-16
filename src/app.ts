import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { NOTE_COLORS, swatchFor } from "./colors";
import { History, type Snapshot } from "./history";
import { escapeHtml, fuzzyMatch, highlight, searchNotes } from "./search";
import { Store } from "./store";
import { allTags } from "./tags";
import { api, type DocChangedPayload, type ResolvedAttachment } from "./tauri";
import type { Attachment, Note, NoteColor } from "./types";

interface ViewState {
  start: number;
  end: number;
  scrollTop: number;
}

interface PaletteItem {
  kind: "note" | "action";
  id: string;
  label: string;
  detail?: string;
  closed?: boolean;
  titleHtml?: string;
  snippetHtml?: string;
  action?: () => void;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"]);

const icons = {
  plus: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3.4v9.2M3.4 8h9.2"/></svg>`,
  search: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.4 13.4"/></svg>`,
  sliders: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 5.2h10M3 10.8h10"/><circle cx="6.2" cy="5.2" r="1.5"/><circle cx="9.8" cy="10.8" r="1.5"/></svg>`,
  close: `<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
  note: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.2 2.6h5.1l2.5 2.5v8.3H4.2z"/><path d="M9.3 2.6v2.5h2.5"/></svg>`,
  archive: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.8 5.4h10.4v7.2H2.8z"/><path d="M2.8 5.4 3.9 2.9h8.2l1.1 2.5"/><path d="M6.4 8.4h3.2"/></svg>`,
  bolt: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8.6 2.2 4.4 8.8h3l-1 5 4.2-6.6h-3z"/></svg>`,
  restore: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.4 6.4A5 5 0 1 1 3.1 8.8"/><path d="M3.2 3.4v3h3"/></svg>`,
  pin: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.3 2.4h3.4l-.6 3.4 2.2 2.2v.9H4.7v-.9l2.2-2.2z"/><path d="M8 8.9v4.7"/></svg>`,
  tag: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.9 8.1V3.3h4.8l5.4 5.4-4.8 4.8z"/><circle cx="5.5" cy="5.5" r="0.8"/></svg>`,
  external: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.4 3h3.6v3.6"/><path d="M13 3 7.8 8.2"/><path d="M12 9.6v2.4A1.6 1.6 0 0 1 10.4 13.6H4.6A1.6 1.6 0 0 1 3 12V6.2a1.6 1.6 0 0 1 1.6-1.6H7"/></svg>`,
};

function pick<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing element ${selector}`);
  return element;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileStem(title: string, id: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  return `${cleaned || "untitled"}-${id.slice(0, 6)}`;
}

export function mountApp(store: Store) {
  const root = pick<HTMLDivElement>("#app");

  root.innerHTML = `
    <div class="shell" id="shell">
      <header class="titlebar">
        <div class="tabs" id="tabs" role="tablist"></div>
        <button class="icon-button" id="new-note" title="New note (⌘N)">${icons.plus}</button>
        <div class="drag-space" data-tauri-drag-region></div>
        <button class="icon-button color-button" id="note-color" title="Note color"><span class="color-dot" id="color-dot"></span></button>
        <button class="icon-button" id="pin-note" title="Pin note (⌘⇧P)">${icons.pin}</button>
        <button class="icon-button" id="open-palette" title="Search (⌘K)">${icons.search}</button>
        <button class="icon-button" id="open-settings" title="Settings (⌘,)">${icons.sliders}</button>
      </header>
      <div class="color-popover" id="color-popover" hidden></div>
      <main class="editor-area" id="editor-area">
        <textarea id="editor" class="editor" placeholder="start typing…" spellcheck="true" autocomplete="off"></textarea>
        <div class="drop-hint" id="drop-hint" hidden>drop images to attach</div>
      </main>
      <div class="attachment-tray" id="attachment-tray" hidden>
        <div class="attachment-head">
          <span class="attachment-label">attachments</span>
          <span class="attachment-count" id="attachment-count"></span>
        </div>
        <div class="attachment-thumbs" id="attachment-thumbs"></div>
      </div>
      <footer class="statusbar">
        <div class="status-group">
          <span id="word-count">0 words</span>
          <span class="save-indicator"><span class="save-dot" id="save-dot"></span><span id="save-label">saved</span></span>
        </div>
        <div class="status-group">
          <span id="note-count">1 note</span>
          <span class="hint">⌘K search · ⌥M hide</span>
        </div>
      </footer>
      <div class="overlay" id="palette-overlay" hidden>
        <div class="palette-panel">
          <input id="palette-input" class="palette-input" type="text" placeholder="search notes, #tags, or run a command…" spellcheck="false" autocomplete="off" />
          <div class="palette-list" id="palette-list"></div>
          <div class="palette-foot"><span>↑↓ navigate</span><span>↵ open</span><span>esc dismiss</span></div>
        </div>
      </div>
      <div class="overlay" id="settings-overlay" hidden>
        <div class="settings-panel">
          <div class="settings-head">
            <span>settings</span>
            <button class="icon-button" id="settings-close" title="Close">${icons.close}</button>
          </div>
          <div class="settings-body">
          <div class="settings-group">
            <div class="setting-row">
              <div class="setting-copy">
                <span class="setting-title">shake to write</span>
                <span class="setting-desc">shake the cursor to summon mote</span>
              </div>
              <label class="switch"><input type="checkbox" id="set-shake" /><span class="track"></span></label>
            </div>
            <div class="setting-row setting-row-column">
              <div class="setting-copy">
                <span class="setting-title">shake sensitivity</span>
                <span class="setting-desc">how vigorous a shake must be</span>
              </div>
              <input type="range" id="set-sensitivity" min="1" max="5" step="1" />
            </div>
            <div class="setting-row">
              <div class="setting-copy">
                <span class="setting-title">hide when inactive</span>
                <span class="setting-desc">dismiss when focus moves away</span>
              </div>
              <label class="switch"><input type="checkbox" id="set-blur" /><span class="track"></span></label>
            </div>
            <div class="setting-row setting-row-column">
              <div class="setting-copy">
                <span class="setting-title">sticky opacity</span>
                <span class="setting-desc">how solid pinned notes look</span>
              </div>
              <input type="range" id="set-opacity" min="0.35" max="1" step="0.01" />
            </div>
            <div class="setting-row">
              <div class="setting-copy">
                <span class="setting-title">open at login</span>
                <span class="setting-desc">start mote with your mac</span>
              </div>
              <label class="switch"><input type="checkbox" id="set-autostart" /><span class="track"></span></label>
            </div>
          </div>
          <div class="settings-group">
            <div class="setting-row">
              <div class="setting-copy">
                <span class="setting-title">global shortcut</span>
                <span class="setting-desc">show or hide from anywhere</span>
              </div>
              <kbd>⌥M</kbd>
            </div>
            <div class="setting-row">
              <div class="setting-copy">
                <span class="setting-title">data folder</span>
                <span class="setting-desc">notes, backups, attachments</span>
              </div>
              <button class="text-button" id="open-data">open</button>
            </div>
            <div class="setting-row">
              <div class="setting-copy">
                <span class="setting-title">trash</span>
                <span class="setting-desc" id="trash-desc">no closed notes</span>
              </div>
              <button class="text-button" id="open-trash">open</button>
            </div>
          </div>
          </div>
          <div class="settings-actions settings-actions-wrap">
            <button class="text-button" id="copy-notes">copy notes as json</button>
            <button class="text-button" id="export-json">export json…</button>
            <button class="text-button" id="export-markdown">export markdown…</button>
            <button class="text-button" id="import-notes">import…</button>
            <button class="text-button danger" id="quit-app">quit mote</button>
          </div>
        </div>
      </div>
      <div class="overlay" id="trash-overlay" hidden>
        <div class="settings-panel trash-panel">
          <div class="settings-head">
            <span>trash</span>
            <button class="icon-button" id="trash-close" title="Close">${icons.close}</button>
          </div>
          <div class="trash-list" id="trash-list"></div>
          <div class="settings-actions">
            <span class="setting-desc" id="trash-count"></span>
            <button class="text-button danger" id="empty-trash">empty trash</button>
          </div>
        </div>
      </div>
      <div class="overlay lightbox" id="lightbox-overlay" hidden>
        <figure class="lightbox-figure">
          <img id="lightbox-image" alt="" />
          <figcaption id="lightbox-caption"></figcaption>
        </figure>
      </div>
      <div class="toast" id="toast" hidden></div>
    </div>
  `;

  const shell = pick<HTMLDivElement>("#shell");
  const tabsEl = pick<HTMLDivElement>("#tabs");
  const editorAreaEl = pick<HTMLElement>("#editor-area");
  const editorEl = pick<HTMLTextAreaElement>("#editor");
  const dropHintEl = pick<HTMLDivElement>("#drop-hint");
  const colorButtonEl = pick<HTMLButtonElement>("#note-color");
  const colorDotEl = pick<HTMLSpanElement>("#color-dot");
  const colorPopover = pick<HTMLDivElement>("#color-popover");
  const pinButtonEl = pick<HTMLButtonElement>("#pin-note");
  const wordCountEl = pick<HTMLSpanElement>("#word-count");
  const noteCountEl = pick<HTMLSpanElement>("#note-count");
  const saveDotEl = pick<HTMLSpanElement>("#save-dot");
  const saveLabelEl = pick<HTMLSpanElement>("#save-label");
  const trayEl = pick<HTMLDivElement>("#attachment-tray");
  const trayThumbsEl = pick<HTMLDivElement>("#attachment-thumbs");
  const trayCountEl = pick<HTMLSpanElement>("#attachment-count");
  const paletteOverlay = pick<HTMLDivElement>("#palette-overlay");
  const paletteInput = pick<HTMLInputElement>("#palette-input");
  const paletteList = pick<HTMLDivElement>("#palette-list");
  const settingsOverlay = pick<HTMLDivElement>("#settings-overlay");
  const trashOverlay = pick<HTMLDivElement>("#trash-overlay");
  const trashList = pick<HTMLDivElement>("#trash-list");
  const trashCountEl = pick<HTMLSpanElement>("#trash-count");
  const trashDescEl = pick<HTMLSpanElement>("#trash-desc");
  const emptyTrashEl = pick<HTMLButtonElement>("#empty-trash");
  const lightboxOverlay = pick<HTMLDivElement>("#lightbox-overlay");
  const lightboxImage = pick<HTMLImageElement>("#lightbox-image");
  const lightboxCaption = pick<HTMLSpanElement>("#lightbox-caption");
  const toastEl = pick<HTMLDivElement>("#toast");
  const setShakeEl = pick<HTMLInputElement>("#set-shake");
  const setSensitivityEl = pick<HTMLInputElement>("#set-sensitivity");
  const setBlurEl = pick<HTMLInputElement>("#set-blur");
  const setOpacityEl = pick<HTMLInputElement>("#set-opacity");
  const setAutostartEl = pick<HTMLInputElement>("#set-autostart");

  let paletteOpen = false;
  let paletteQuery = "";
  let paletteIndex = 0;
  let paletteItems: PaletteItem[] = [];
  let settingsOpen = false;
  let trashOpen = false;
  let colorPopoverOpen = false;
  let lightboxOpen = false;
  let toastTimer: number | undefined;
  let toastHideTimer: number | undefined;
  let saveTimer: number | undefined;
  let stickySyncTimer: number | undefined;
  let lastTrayKey = "";
  const pendingStickyIds = new Set<string>();
  const history = new History();
  const viewStates = new Map<string, ViewState>();
  const confirmTimers = new WeakMap<HTMLButtonElement, number>();
  const attachmentPaths = new Map<string, ResolvedAttachment>();

  function docChangedPayload(note: Note): DocChangedPayload {
    return {
      id: note.id,
      title: note.title,
      body: note.body,
      color: note.color,
      opacity: store.doc.settings.stickyOpacity,
      attachmentCount: note.attachments.length,
    };
  }

  function renderTabs() {
    tabsEl.innerHTML = "";
    for (const note of store.notes()) {
      const tab = document.createElement("div");
      tab.className = `tab${note.id === store.doc.activeId ? " is-active" : ""}`;
      tab.setAttribute("role", "tab");
      tab.dataset.id = note.id;
      tab.tabIndex = -1;
      tab.title = note.title || "Untitled";

      const swatch = swatchFor(note.color);
      if (swatch) {
        const dot = document.createElement("span");
        dot.className = "tab-color";
        dot.style.background = swatch.hex;
        tab.append(dot);
      }

      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = note.title || "Untitled";

      const close = document.createElement("span");
      close.className = "tab-close";
      close.innerHTML = icons.close;
      close.addEventListener("pointerdown", (event) => event.stopPropagation());
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        closeNote(note.id);
      });

      tab.append(title, close);
      tab.addEventListener("click", () => selectNote(note.id));
      tab.addEventListener("auxclick", (event) => {
        if (event.button === 1) closeNote(note.id);
      });
      tabsEl.append(tab);
    }
    const active = tabsEl.querySelector(".tab.is-active");
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function renderEditor() {
    const note = store.active();
    editorEl.value = note?.body ?? "";
    const state = note ? viewStates.get(note.id) : undefined;
    editorEl.scrollTop = state?.scrollTop ?? 0;
    if (note && !history.has(note.id)) {
      history.reset(note.id, { body: note.body, start: note.body.length, end: note.body.length });
    }
    renderStatus();
    refreshPinButton();
    refreshColorButton();
    renderTray();
  }

  function renderStatus() {
    const body = editorEl.value;
    const words = body.trim() ? body.trim().split(/\s+/).length : 0;
    wordCountEl.textContent = `${words} ${words === 1 ? "word" : "words"}`;
    const count = store.doc.tabOrder.length;
    noteCountEl.textContent = `${count} ${count === 1 ? "note" : "notes"}`;
  }

  function renderAll() {
    renderTabs();
    renderEditor();
  }

  function updateTabTitle(id: string) {
    const note = store.doc.notes.find((value) => value.id === id);
    if (!note) return;
    const title = note.title || "Untitled";
    const tabEl = [...tabsEl.children].find(
      (child) => (child as HTMLElement).dataset.id === id,
    ) as HTMLElement | undefined;
    if (!tabEl) return;
    const titleEl = tabEl.querySelector(".tab-title");
    if (titleEl) titleEl.textContent = title;
    tabEl.setAttribute("title", title);
  }

  function currentSnapshot(): Snapshot {
    return { body: editorEl.value, start: editorEl.selectionStart, end: editorEl.selectionEnd };
  }

  function captureViewState(id: string) {
    viewStates.set(id, {
      start: editorEl.selectionStart,
      end: editorEl.selectionEnd,
      scrollTop: editorEl.scrollTop,
    });
  }

  function restoreViewState(id: string) {
    const state = viewStates.get(id);
    const max = editorEl.value.length;
    const start = state ? Math.min(state.start, max) : max;
    const end = state ? Math.min(state.end, max) : max;
    editorEl.setSelectionRange(start, end);
    const scrollTop = state?.scrollTop ?? 0;
    requestAnimationFrame(() => {
      editorEl.scrollTop = scrollTop;
    });
  }

  function focusEditor(restore = false) {
    editorEl.focus();
    const active = store.active();
    if (restore && active) {
      restoreViewState(active.id);
      return;
    }
    const end = editorEl.value.length;
    editorEl.setSelectionRange(end, end);
  }

  function applySnapshot(snapshot: Snapshot) {
    const active = store.active();
    if (!active || active.closedAt) return;
    editorEl.value = snapshot.body;
    const max = snapshot.body.length;
    const start = Math.min(snapshot.start, max);
    const end = Math.min(snapshot.end, max);
    editorEl.setSelectionRange(start, end);
    viewStates.set(active.id, { start, end, scrollTop: editorEl.scrollTop });
    store.updateBody(active.id, snapshot.body);
    updateTabTitle(active.id);
    renderStatus();
    markSaving();
    syncStickies(active.id);
  }

  function markSaved() {
    saveDotEl.classList.remove("is-saving");
    saveDotEl.classList.remove("is-error");
    saveLabelEl.textContent = "saved";
  }

  function markSaving() {
    saveDotEl.classList.add("is-saving");
    saveDotEl.classList.remove("is-error");
    saveLabelEl.textContent = "saving…";
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(markSaved, 420);
  }

  function markSaveError() {
    if (saveTimer) clearTimeout(saveTimer);
    saveDotEl.classList.remove("is-saving");
    saveDotEl.classList.add("is-error");
    saveLabelEl.textContent = "save failed";
  }

  function selectNote(id: string) {
    const isCurrent = store.doc.activeId === id && store.doc.tabOrder.includes(id);
    if (isCurrent) {
      focusEditor(true);
      return;
    }
    const current = store.active();
    if (current) {
      captureViewState(current.id);
      history.record(current.id, currentSnapshot(), { coalesceMs: 0 });
    }
    store.open(id);
    renderAll();
    focusEditor(true);
  }

  function closeNote(id: string) {
    const wasPinned = store.isPinned(id);
    if (store.doc.activeId === id) {
      history.record(id, currentSnapshot(), { coalesceMs: 0 });
    }
    store.close(id);
    if (wasPinned) void api.unpinNote(id);
    renderAll();
    focusEditor();
    showToast("moved to trash · restore with ⌘K");
  }

  function addNote(body = "") {
    store.create(body);
    renderAll();
    focusEditor();
  }

  function refreshPinButton() {
    const active = store.active();
    const pinned = Boolean(active && store.isPinned(active.id));
    pinButtonEl.classList.toggle("is-active", pinned);
    pinButtonEl.title = pinned ? "Unpin note (⌘⇧P)" : "Pin note (⌘⇧P)";
  }

  function refreshColorButton() {
    const swatch = swatchFor(store.active()?.color);
    colorDotEl.style.background = swatch?.hex ?? "transparent";
    colorButtonEl.classList.toggle("is-active", Boolean(swatch));
  }

  function togglePinActive() {
    const active = store.active();
    if (!active || active.closedAt) return;
    const pinned = store.togglePin(active.id);
    refreshPinButton();
    if (pinned) {
      void api.pinNote(active.id, active.title).catch(() => {
        store.unpin(active.id);
        refreshPinButton();
        showToast("could not pin this note");
      });
      showToast("pinned to your desktop");
    } else {
      void api.unpinNote(active.id);
      showToast("unpinned");
    }
  }

  function syncStickies(noteId: string) {
    if (!store.isPinned(noteId)) return;
    pendingStickyIds.add(noteId);
    if (stickySyncTimer) clearTimeout(stickySyncTimer);
    stickySyncTimer = window.setTimeout(() => {
      stickySyncTimer = undefined;
      const ids = [...pendingStickyIds];
      pendingStickyIds.clear();
      for (const id of ids) {
        const note = store.find(id);
        if (!note || note.closedAt) continue;
        void api.emitDocChanged(docChangedPayload(note));
      }
    }, 120);
  }

  function cycleTabs(direction: number) {
    const notes = store.notes();
    if (notes.length < 2) return;
    const current = notes.findIndex((note) => note.id === store.doc.activeId);
    const next = (current + direction + notes.length) % notes.length;
    selectNote(notes[next].id);
  }

  function showToast(message: string) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    requestAnimationFrame(() => toastEl.classList.add("is-visible"));
    if (toastTimer) clearTimeout(toastTimer);
    if (toastHideTimer) clearTimeout(toastHideTimer);
    toastTimer = window.setTimeout(() => {
      toastEl.classList.remove("is-visible");
      toastHideTimer = window.setTimeout(() => {
        toastEl.hidden = true;
        toastHideTimer = undefined;
      }, 240);
    }, 1900);
  }

  function renderTray(force = false) {
    const note = store.active();
    const attachments = note?.attachments ?? [];
    if (!note || attachments.length === 0) {
      trayEl.hidden = true;
      trayThumbsEl.innerHTML = "";
      lastTrayKey = "";
      return;
    }
    trayEl.hidden = false;
    const count = attachments.length;
    trayCountEl.textContent = `${count} ${count === 1 ? "image" : "images"}`;
    const key = `${note.id}:${attachments.map((value) => value.id).join(",")}`;
    if (!force && key === lastTrayKey) return;
    lastTrayKey = key;
    trayThumbsEl.innerHTML = "";

    for (const attachment of attachments) {
      const figure = document.createElement("figure");
      figure.className = "attachment-thumb";
      figure.title = `${attachment.name} · ${formatBytes(attachment.size)}`;

      const image = document.createElement("img");
      image.alt = attachment.name;
      image.loading = "lazy";
      image.dataset.attachment = attachment.id;

      const remove = document.createElement("button");
      remove.className = "attachment-remove";
      remove.title = "Remove image";
      remove.innerHTML = icons.close;
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        removeAttachment(attachment);
      });

      const reveal = document.createElement("button");
      reveal.className = "attachment-reveal";
      reveal.title = "Reveal in Finder";
      reveal.innerHTML = icons.external;
      reveal.addEventListener("click", (event) => {
        event.stopPropagation();
        void api.revealAttachment(attachment.id, attachment.ext).catch(() => {
          showToast("could not reveal that file");
        });
      });

      figure.append(image, remove, reveal);
      figure.addEventListener("click", () => {
        void openLightbox(attachment);
      });
      trayThumbsEl.append(figure);
      void hydrateThumb(image, attachment);
    }
  }

  async function resolveAttachment(attachment: Attachment): Promise<ResolvedAttachment | null> {
    const key = `${attachment.id}.${attachment.ext}`;
    const cached = attachmentPaths.get(key);
    if (cached) return cached;
    try {
      const resolved = await api.resolveAttachment(attachment.id, attachment.ext);
      attachmentPaths.set(key, resolved);
      return resolved;
    } catch {
      return null;
    }
  }

  async function hydrateThumb(image: HTMLImageElement, attachment: Attachment) {
    const resolved = await resolveAttachment(attachment);
    const source = resolved?.thumb ?? resolved?.path;
    if (!source) return;
    image.src = convertFileSrc(source);
    image.classList.add("is-loaded");
  }

  async function openLightbox(attachment: Attachment) {
    const resolved = await resolveAttachment(attachment);
    const source = resolved?.path ?? resolved?.thumb;
    if (!source) {
      showToast("image file is missing");
      return;
    }
    lightboxImage.src = convertFileSrc(source);
    lightboxImage.alt = attachment.name;
    lightboxCaption.textContent = `${attachment.name} · ${formatBytes(attachment.size)}`;
    lightboxOverlay.hidden = false;
    lightboxOpen = true;
  }

  function closeLightbox(focus = true) {
    lightboxOpen = false;
    lightboxOverlay.hidden = true;
    lightboxImage.removeAttribute("src");
    if (focus) focusEditor();
  }

  function refreshAttachments() {
    renderTray(true);
    const active = store.active();
    if (active) syncStickies(active.id);
  }

  async function handleDrop(paths: string[]) {
    const active = store.active();
    if (!active) return;
    const images = paths.filter((path) => {
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      return IMAGE_EXTENSIONS.has(ext);
    });
    if (images.length === 0) {
      showToast("only images can be attached");
      return;
    }
    let added = 0;
    for (const path of images) {
      try {
        const imported = await api.importAttachment(path);
        attachmentPaths.set(`${imported.id}.${imported.ext}`, {
          path: imported.path,
          thumb: imported.thumb,
        });
        store.addAttachment(active.id, {
          id: imported.id,
          name: imported.name,
          ext: imported.ext,
          size: imported.size,
          createdAt: Date.now(),
        });
        added += 1;
      } catch (error) {
        console.error("mote: could not attach image", error);
      }
    }
    if (added === 0) {
      showToast("could not attach those images");
      return;
    }
    refreshAttachments();
    renderTabs();
    showToast(added === 1 ? "image attached" : `${added} images attached`);
  }

  function removeAttachment(attachment: Attachment) {
    const active = store.active();
    if (!active) return;
    store.removeAttachment(active.id, attachment.id);
    refreshAttachments();
    void api.pruneAttachments(store.referencedAttachmentIds());
    showToast("image removed");
  }

  function openColorPopover() {
    const active = store.active();
    colorPopover.innerHTML = "";
    for (const swatch of NOTE_COLORS) {
      const button = document.createElement("button");
      button.className = `swatch${active?.color === swatch.id ? " is-active" : ""}`;
      button.style.setProperty("--swatch", swatch.hex);
      button.title = swatch.label;
      button.addEventListener("click", () => setActiveColor(swatch.id));
      colorPopover.append(button);
    }
    const none = document.createElement("button");
    none.className = `swatch swatch-none${active?.color ? "" : " is-active"}`;
    none.title = "no color";
    none.addEventListener("click", () => setActiveColor(undefined));
    colorPopover.append(none);

    const buttonRect = colorButtonEl.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    colorPopover.style.top = `${buttonRect.bottom - shellRect.top + 6}px`;
    colorPopover.style.right = `${shellRect.right - buttonRect.right}px`;
    colorPopover.hidden = false;
    colorPopoverOpen = true;
  }

  function closeColorPopover() {
    colorPopoverOpen = false;
    colorPopover.hidden = true;
  }

  function setActiveColor(color: NoteColor | undefined) {
    const active = store.active();
    closeColorPopover();
    if (!active) return;
    store.setColor(active.id, color);
    renderTabs();
    refreshColorButton();
    syncStickies(active.id);
  }

  async function exportNotes() {
    const payload = JSON.stringify(
      { app: "mote", exportedAt: new Date().toISOString(), notes: store.doc.notes },
      null,
      2,
    );
    try {
      await navigator.clipboard.writeText(payload);
      showToast("notes json copied to clipboard");
    } catch {
      showToast("could not access the clipboard");
    }
  }

  function notesPayload(pretty = true): string {
    return JSON.stringify(
      { app: "mote", version: store.doc.version, exportedAt: new Date().toISOString(), notes: store.doc.notes },
      null,
      pretty ? 2 : undefined,
    );
  }

  async function exportJsonFile() {
    try {
      const path = await save({
        title: "Export notes",
        defaultPath: `mote-notes-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await api.writeTextFile(path, notesPayload());
      showToast("notes exported as json");
    } catch (error) {
      console.error("mote: export failed", error);
      showToast("could not export notes");
    }
  }

  async function exportMarkdownFiles() {
    try {
      const dir = await open({ title: "Export notes as markdown", directory: true });
      const target = Array.isArray(dir) ? dir[0] : dir;
      if (!target) return;
      const files = store.doc.notes.map((note) => ({
        name: fileStem(note.title, note.id),
        contents: note.body,
      }));
      const count = await api.exportMarkdownDir(target, files);
      showToast(`exported ${count} markdown ${count === 1 ? "file" : "files"}`);
    } catch (error) {
      console.error("mote: markdown export failed", error);
      showToast("could not export markdown");
    }
  }

  async function importNotesFile() {
    try {
      const path = await open({
        title: "Import notes",
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      const target = Array.isArray(path) ? path[0] : path;
      if (!target) return;
      const raw = await api.readTextFile(target);
      const added = store.importNotes(JSON.parse(raw));
      renderAll();
      refreshTrashMeta();
      showToast(added > 0 ? `imported ${added} ${added === 1 ? "note" : "notes"}` : "nothing new to import");
    } catch (error) {
      console.error("mote: import failed", error);
      showToast("could not import that file");
    }
  }

  function paletteActions(): PaletteItem[] {
    const query = paletteQuery.trim();
    const items: PaletteItem[] = [];
    const tagQuery = query.startsWith("#") ? query.slice(1).split(/\s+/)[0].toLowerCase() : null;

    if (tagQuery !== null) {
      const tags = allTags(store.doc.notes.map((note) => note.tags))
        .filter((tag) => !tagQuery || tag.includes(tagQuery))
        .slice(0, 5);
      for (const tag of tags) {
        items.push({
          kind: "action",
          id: `tag-${tag}`,
          label: `filter #${tag}`,
          detail: "tag",
          action: () => {
            paletteInput.value = `#${tag} `;
            paletteQuery = paletteInput.value;
            paletteIndex = 0;
            renderPalette();
            paletteInput.focus();
          },
        });
      }
    }

    if (query && tagQuery === null) {
      items.push({
        kind: "action",
        id: "create",
        label: `create “${query}”`,
        detail: "new note",
        action: () => {
          closePalette(false);
          addNote(query);
        },
      });
    } else if (!query) {
      items.push({
        kind: "action",
        id: "new",
        label: "new note",
        detail: "⌘N",
        action: () => {
          closePalette(false);
          addNote();
        },
      });
    }

    items.push({
      kind: "action",
      id: "settings",
      label: "settings",
      detail: "⌘,",
      action: () => {
        closePalette(false);
        void openSettings();
      },
    });

    const activeNote = store.active();
    if (activeNote && !activeNote.closedAt) {
      const pinned = store.isPinned(activeNote.id);
      items.push({
        kind: "action",
        id: "pin",
        label: pinned ? "unpin note" : "pin note",
        detail: "⌘⇧P",
        action: () => {
          closePalette(false);
          togglePinActive();
        },
      });
      items.push({
        kind: "action",
        id: "duplicate",
        label: "duplicate note",
        action: () => {
          closePalette(false);
          const copy = store.duplicate(activeNote.id);
          if (copy) {
            renderAll();
            focusEditor();
            showToast("note duplicated");
          }
        },
      });
    }

    items.push({
      kind: "action",
      id: "sort",
      label: "sort tabs by recent",
      action: () => {
        store.sortTabsByRecent();
        renderTabs();
        closePalette(false);
        showToast("tabs sorted by most recent");
      },
    });

    items.push({
      kind: "action",
      id: "shake",
      label: store.doc.settings.shakeEnabled ? "disable shake to write" : "enable shake to write",
      action: () => {
        const next = !store.doc.settings.shakeEnabled;
        store.setSetting("shakeEnabled", next);
        void api.setShakeEnabled(next);
        closePalette(false);
        showToast(next ? "shake to write on" : "shake to write off");
      },
    });

    items.push({
      kind: "action",
      id: "export",
      label: "copy notes as json",
      action: () => {
        closePalette(false);
        void exportNotes();
      },
    });

    items.push({
      kind: "action",
      id: "trash",
      label: "open trash",
      detail: store.trashed().length > 0 ? String(store.trashed().length) : "",
      action: () => {
        closePalette(false);
        openTrash();
      },
    });

    items.push({
      kind: "action",
      id: "hide",
      label: "hide mote",
      detail: "esc",
      action: () => {
        closePalette(false);
        void api.hide();
      },
    });

    return items.filter((item) => !query || fuzzyMatch(item.label, query));
  }

  function buildPalette(): PaletteItem[] {
    const query = paletteQuery.trim();
    let pool = store.doc.notes;
    let search = query;
    if (query.startsWith("#")) {
      const [tag, ...rest] = query.slice(1).split(/\s+/);
      if (tag) pool = pool.filter((note) => note.tags.includes(tag.toLowerCase()));
      search = rest.join(" ");
    }
    const noteItems: PaletteItem[] = searchNotes(pool, search).map((match) => {
      const tags = match.note.tags.slice(0, 2).map((tag) => `#${tag}`).join(" ");
      const detail = match.note.closedAt ? "closed" : tags || relativeTime(match.note.updatedAt);
      return {
        kind: "note",
        id: match.note.id,
        label: match.note.title,
        detail,
        closed: Boolean(match.note.closedAt),
        titleHtml: highlight(match.note.title, match.titleRanges),
        snippetHtml: match.snippet ? highlight(match.snippet, match.snippetRanges) : "",
        action: () => {
          closePalette(false);
          selectNote(match.note.id);
        },
      };
    });
    const actions = paletteActions();
    if (query && noteItems.length === 0) return [...actions, ...noteItems];
    return [...noteItems, ...actions];
  }

  function updatePaletteActive() {
    const children = paletteList.children;
    for (let index = 0; index < children.length; index += 1) {
      children[index].classList.toggle("is-active", index === paletteIndex);
    }
    children[paletteIndex]?.scrollIntoView({ block: "nearest" });
  }

  function renderPalette() {
    paletteItems = buildPalette();
    paletteIndex = Math.max(0, Math.min(paletteIndex, paletteItems.length - 1));
    paletteList.innerHTML = "";

    if (paletteItems.length === 0) {
      const empty = document.createElement("div");
      empty.className = "palette-empty";
      empty.textContent = "no matches";
      paletteList.append(empty);
      return;
    }

    paletteItems.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = `palette-item${index === paletteIndex ? " is-active" : ""}${item.closed ? " is-closed" : ""}`;
      row.setAttribute("role", "option");
      const icon =
        item.kind === "note"
          ? item.closed
            ? icons.archive
            : icons.note
          : item.id.startsWith("tag-")
            ? icons.tag
            : icons.bolt;
      row.innerHTML = `
        <span class="palette-icon">${icon}</span>
        <span class="palette-copy">
          <span class="palette-title">${item.titleHtml ?? escapeHtml(item.label)}</span>
          ${item.snippetHtml ? `<span class="palette-snippet">${item.snippetHtml}</span>` : ""}
        </span>
        <span class="palette-detail">${item.detail ? escapeHtml(item.detail) : ""}</span>
      `;
      row.addEventListener("pointerenter", () => {
        paletteIndex = index;
        updatePaletteActive();
      });
      row.addEventListener("click", () => item.action?.());
      paletteList.append(row);
    });

    updatePaletteActive();
  }

  function openPalette(initialQuery = "") {
    paletteOpen = true;
    paletteQuery = initialQuery;
    paletteIndex = 0;
    paletteInput.value = initialQuery;
    paletteOverlay.hidden = false;
    renderPalette();
    paletteInput.focus();
    paletteInput.setSelectionRange(paletteInput.value.length, paletteInput.value.length);
  }

  function closePalette(focus = true) {
    paletteOpen = false;
    paletteOverlay.hidden = true;
    if (focus) focusEditor();
  }

  function runPaletteItem() {
    const item = paletteItems[paletteIndex];
    if (item) item.action?.();
  }

  async function openSettings() {
    closeTrash(false);
    settingsOpen = true;
    settingsOverlay.hidden = false;
    refreshTrashMeta();
    setShakeEl.checked = store.doc.settings.shakeEnabled;
    setSensitivityEl.value = String(store.doc.settings.shakeSensitivity);
    setBlurEl.checked = store.doc.settings.hideOnBlur;
    setOpacityEl.value = String(store.doc.settings.stickyOpacity);
    setAutostartEl.disabled = true;
    try {
      setAutostartEl.checked = await api.getAutostart();
    } catch {
      setAutostartEl.checked = false;
    }
    setAutostartEl.disabled = false;
  }

  function closeSettings(focus = true) {
    settingsOpen = false;
    settingsOverlay.hidden = true;
    if (focus) focusEditor();
  }

  function trashLabel(): string {
    const count = store.trashed().length;
    if (count === 0) return "no closed notes";
    return `${count} closed ${count === 1 ? "note" : "notes"}`;
  }

  function refreshTrashMeta() {
    trashDescEl.textContent = trashLabel();
  }

  function armConfirm(button: HTMLButtonElement, confirmText: string): boolean {
    const armedTimer = confirmTimers.get(button);
    if (button.classList.contains("is-armed")) {
      if (armedTimer) clearTimeout(armedTimer);
      button.classList.remove("is-armed");
      button.textContent = button.dataset.label ?? "";
      return true;
    }
    if (button.dataset.label === undefined) {
      button.dataset.label = button.textContent ?? "";
    }
    button.classList.add("is-armed");
    button.textContent = confirmText;
    confirmTimers.set(
      button,
      window.setTimeout(() => {
        button.classList.remove("is-armed");
        button.textContent = button.dataset.label ?? "";
      }, 3000),
    );
    return false;
  }

  function renderTrash() {
    const items = store.trashed();
    trashList.innerHTML = "";
    emptyTrashEl.disabled = items.length === 0;
    trashCountEl.textContent =
      items.length === 0 ? "" : `${items.length} ${items.length === 1 ? "note" : "notes"}`;

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "palette-empty";
      empty.textContent = "trash is empty";
      trashList.append(empty);
      return;
    }

    for (const note of items) {
      const row = document.createElement("div");
      row.className = "trash-item";

      const copy = document.createElement("div");
      copy.className = "trash-copy";
      const title = document.createElement("span");
      title.className = "trash-title";
      title.textContent = note.title || "Untitled";
      const meta = document.createElement("span");
      meta.className = "trash-meta";
      meta.textContent = `closed ${relativeTime(note.closedAt ?? note.updatedAt)}`;
      copy.append(title, meta);

      const restore = document.createElement("button");
      restore.className = "icon-button";
      restore.title = "Restore";
      restore.innerHTML = icons.restore;
      restore.addEventListener("click", () => {
        store.open(note.id);
        renderAll();
        renderTrash();
        refreshTrashMeta();
        showToast("restored");
      });

      const remove = document.createElement("button");
      remove.className = "text-button danger";
      remove.textContent = "delete";
      remove.addEventListener("click", () => {
        if (!armConfirm(remove, "sure?")) return;
        store.deleteForever(note.id);
        history.discard(note.id);
        void api.forgetPin(note.id);
        void api.pruneAttachments(store.referencedAttachmentIds());
        renderTrash();
        refreshTrashMeta();
        showToast("deleted forever");
      });

      row.append(copy, restore, remove);
      trashList.append(row);
    }
  }

  function openTrash() {
    closeSettings(false);
    closePalette(false);
    trashOpen = true;
    renderTrash();
    trashOverlay.hidden = false;
  }

  function closeTrash(focus = true) {
    trashOpen = false;
    trashOverlay.hidden = true;
    if (focus) focusEditor();
  }

  function pulseShell() {
    shell.classList.remove("is-popping");
    void shell.offsetWidth;
    shell.classList.add("is-popping");
  }

  shell.addEventListener("animationend", (event) => {
    if (event.animationName === "shell-pop") shell.classList.remove("is-popping");
  });

  colorButtonEl.addEventListener("click", () => {
    if (colorPopoverOpen) closeColorPopover();
    else openColorPopover();
  });

  pick<HTMLButtonElement>("#new-note").addEventListener("click", () => addNote());
  pick<HTMLButtonElement>("#pin-note").addEventListener("click", () => togglePinActive());
  pick<HTMLButtonElement>("#open-palette").addEventListener("click", () => openPalette());
  pick<HTMLButtonElement>("#open-settings").addEventListener("click", () => {
    void openSettings();
  });
  pick<HTMLButtonElement>("#settings-close").addEventListener("click", () => closeSettings());
  pick<HTMLButtonElement>("#trash-close").addEventListener("click", () => closeTrash());
  pick<HTMLButtonElement>("#open-trash").addEventListener("click", () => openTrash());
  pick<HTMLButtonElement>("#open-data").addEventListener("click", () => {
    void api.openDataDir().catch(() => showToast("could not open the data folder"));
  });
  emptyTrashEl.addEventListener("click", () => {
    if (!armConfirm(emptyTrashEl, "sure?")) return;
    const removed = store.trashed().map((note) => note.id);
    for (const id of removed) {
      history.discard(id);
      void api.forgetPin(id);
    }
    store.emptyTrash();
    void api.pruneAttachments(store.referencedAttachmentIds());
    renderTrash();
    refreshTrashMeta();
    showToast("trash emptied");
  });
  pick<HTMLButtonElement>("#copy-notes").addEventListener("click", () => {
    void exportNotes();
  });
  pick<HTMLButtonElement>("#export-json").addEventListener("click", () => {
    void exportJsonFile();
  });
  pick<HTMLButtonElement>("#export-markdown").addEventListener("click", () => {
    void exportMarkdownFiles();
  });
  pick<HTMLButtonElement>("#import-notes").addEventListener("click", () => {
    void importNotesFile();
  });
  pick<HTMLButtonElement>("#quit-app").addEventListener("click", () => {
    void api.quit();
  });

  paletteOverlay.addEventListener("mousedown", (event) => {
    if (event.target === paletteOverlay) closePalette();
  });
  settingsOverlay.addEventListener("mousedown", (event) => {
    if (event.target === settingsOverlay) closeSettings();
  });
  trashOverlay.addEventListener("mousedown", (event) => {
    if (event.target === trashOverlay) closeTrash();
  });
  lightboxOverlay.addEventListener("mousedown", (event) => {
    if (event.target === lightboxOverlay) closeLightbox();
  });

  document.addEventListener("pointerdown", (event) => {
    if (!colorPopoverOpen) return;
    const target = event.target as Node;
    if (colorPopover.contains(target) || colorButtonEl.contains(target)) return;
    closeColorPopover();
  });

  paletteInput.addEventListener("input", () => {
    paletteQuery = paletteInput.value;
    paletteIndex = 0;
    renderPalette();
  });

  paletteInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      paletteIndex = Math.min(paletteIndex + 1, Math.max(0, paletteItems.length - 1));
      updatePaletteActive();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      paletteIndex = Math.max(paletteIndex - 1, 0);
      updatePaletteActive();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runPaletteItem();
    }
  });

  editorEl.addEventListener("input", () => {
    const active = store.active();
    if (!active) return;
    store.updateBody(active.id, editorEl.value);
    history.record(active.id, currentSnapshot());
    updateTabTitle(active.id);
    renderStatus();
    markSaving();
    syncStickies(active.id);
  });

  editorEl.addEventListener("keydown", (event) => {
    const active = store.active();
    if (
      active &&
      event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      event.key.toLowerCase() === "z"
    ) {
      event.preventDefault();
      const snapshot = event.shiftKey ? history.redo(active.id) : history.undo(active.id);
      if (snapshot) applySnapshot(snapshot);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const start = editorEl.selectionStart;
      const end = editorEl.selectionEnd;
      editorEl.setRangeText("  ", start, end, "end");
      editorEl.dispatchEvent(new Event("input"));
    }
  });

  editorEl.addEventListener("beforeinput", (event) => {
    if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
      event.preventDefault();
    }
  });

  setShakeEl.addEventListener("change", () => {
    const next = setShakeEl.checked;
    store.setSetting("shakeEnabled", next);
    void api.setShakeEnabled(next);
  });

  setSensitivityEl.addEventListener("input", () => {
    const value = Number(setSensitivityEl.value);
    store.setSetting("shakeSensitivity", value);
    void api.setShakeSensitivity(value);
  });

  setBlurEl.addEventListener("change", () => {
    const next = setBlurEl.checked;
    store.setSetting("hideOnBlur", next);
    void api.setHideOnBlur(next);
  });

  setOpacityEl.addEventListener("input", () => {
    const value = Number(setOpacityEl.value);
    store.setSetting("stickyOpacity", value);
    void api.emitSettingsChanged({ opacity: value });
  });

  setAutostartEl.addEventListener("change", async () => {
    const next = setAutostartEl.checked;
    try {
      await api.setAutostart(next);
      showToast(next ? "mote will open at login" : "launch at login disabled");
    } catch {
      setAutostartEl.checked = !next;
      showToast("could not update the login item");
    }
  });

  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();

    if (key === "escape") {
      event.preventDefault();
      if (lightboxOpen) {
        closeLightbox();
        return;
      }
      if (colorPopoverOpen) {
        closeColorPopover();
        focusEditor();
        return;
      }
      if (trashOpen) {
        closeTrash();
        return;
      }
      if (settingsOpen) {
        closeSettings();
        return;
      }
      if (paletteOpen) {
        closePalette();
        return;
      }
      void store.flush();
      void api.hide();
      return;
    }

    if (paletteOpen) return;

    if (event.ctrlKey && event.key === "Tab") {
      event.preventDefault();
      cycleTabs(event.shiftKey ? -1 : 1);
      return;
    }

    if (!event.metaKey) return;

    if (key === "k") {
      event.preventDefault();
      openPalette();
      return;
    }
    if (key === "n") {
      event.preventDefault();
      addNote();
      return;
    }
    if (key === "w") {
      event.preventDefault();
      const active = store.active();
      if (active) closeNote(active.id);
      return;
    }
    if (key === ",") {
      event.preventDefault();
      if (settingsOpen) closeSettings();
      else void openSettings();
      return;
    }
    if (key === "e" && event.shiftKey) {
      event.preventDefault();
      void exportNotes();
      return;
    }
    if (key === "p" && event.shiftKey) {
      event.preventDefault();
      togglePinActive();
      return;
    }
    if (key >= "1" && key <= "9") {
      const notes = store.notes();
      const target = notes[Number(key) - 1];
      if (target) {
        event.preventDefault();
        selectNote(target.id);
      }
    }
  });

  window.addEventListener("blur", () => {
    const active = store.active();
    if (active) {
      captureViewState(active.id);
      history.record(active.id, currentSnapshot(), { coalesceMs: 0 });
    }
    void store.flush();
    void api.setPointerDown(false);
  });

  window.addEventListener("pointerdown", () => {
    void api.setPointerDown(true);
  });
  window.addEventListener("pointerup", () => {
    void api.setPointerDown(false);
  });
  window.addEventListener("pointercancel", () => {
    void api.setPointerDown(false);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) void store.flush();
  });

  void getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "enter" || event.payload.type === "over") {
      editorAreaEl.classList.add("is-dropping");
      dropHintEl.hidden = false;
    } else if (event.payload.type === "leave") {
      editorAreaEl.classList.remove("is-dropping");
      dropHintEl.hidden = true;
    } else if (event.payload.type === "drop") {
      editorAreaEl.classList.remove("is-dropping");
      dropHintEl.hidden = true;
      void handleDrop(event.payload.paths);
    }
  });

  store.onPersisted = () => markSaved();
  store.onPersistError = (error) => {
    console.error("mote: could not save notes", error);
    markSaveError();
  };
  if (store.lastError) markSaveError();

  void api.onShown(pulseShell);
  void api.onShake(pulseShell);
  void api.setShakeEnabled(store.doc.settings.shakeEnabled);
  void api.setShakeSensitivity(store.doc.settings.shakeSensitivity);
  void api.setHideOnBlur(store.doc.settings.hideOnBlur);

  void api.onStickyEdit(({ id, body }) => {
    const note = store.find(id);
    if (!note || note.closedAt) {
      void api.unpinNote(id);
      return;
    }
    store.updateBody(id, body);
    history.record(id, { body, start: body.length, end: body.length }, { coalesceMs: 0 });
    if (store.doc.activeId === id && document.activeElement !== editorEl) {
      editorEl.value = body;
      renderStatus();
    }
    updateTabTitle(id);
    syncStickies(id);
  });

  void api.onStickyReady((id) => {
    const note = store.find(id);
    if (!note || note.closedAt) {
      void api.unpinNote(id);
      return;
    }
    void api.emitDocChanged(docChangedPayload(note));
  });

  void api.onPinClosed((id) => {
    store.unpin(id);
    refreshPinButton();
  });

  for (const id of [...store.doc.settings.pinnedIds]) {
    const note = store.find(id);
    if (!note || note.closedAt) {
      store.unpin(id);
      continue;
    }
    void api.pinNote(id, note.title).catch(() => {
      store.unpin(id);
      refreshPinButton();
    });
  }

  renderAll();
  focusEditor();
}
