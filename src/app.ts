import { History, type Snapshot } from "./history";
import { escapeHtml, fuzzyMatch, highlight, searchNotes } from "./search";
import { Store } from "./store";
import { api } from "./tauri";

interface ViewState {
  start: number;
  end: number;
  scrollTop: number;
}

export const store = new Store();

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

export function mountApp() {
  const root = pick<HTMLDivElement>("#app");

  root.innerHTML = `
    <div class="shell" id="shell">
      <header class="titlebar">
        <div class="tabs" id="tabs" role="tablist"></div>
        <button class="icon-button" id="new-note" title="New note (⌘N)">${icons.plus}</button>
        <div class="drag-space" data-tauri-drag-region></div>
        <button class="icon-button" id="pin-note" title="Pin note (⌘⇧P)">${icons.pin}</button>
        <button class="icon-button" id="open-palette" title="Search (⌘K)">${icons.search}</button>
        <button class="icon-button" id="open-settings" title="Settings (⌘,)">${icons.sliders}</button>
      </header>
      <main class="editor-area">
        <textarea id="editor" class="editor" placeholder="start typing…" spellcheck="true" autocomplete="off"></textarea>
      </main>
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
          <input id="palette-input" class="palette-input" type="text" placeholder="search notes or run a command…" spellcheck="false" autocomplete="off" />
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
                <span class="setting-title">trash</span>
                <span class="setting-desc" id="trash-desc">no closed notes</span>
              </div>
              <button class="text-button" id="open-trash">open</button>
            </div>
          </div>
          </div>
          <div class="settings-actions">
            <button class="text-button" id="export-notes">copy notes as json</button>
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
      <div class="toast" id="toast" hidden></div>
    </div>
  `;

  const shell = pick<HTMLDivElement>("#shell");
  const tabsEl = pick<HTMLDivElement>("#tabs");
  const editorEl = pick<HTMLTextAreaElement>("#editor");
  const pinButtonEl = pick<HTMLButtonElement>("#pin-note");
  const wordCountEl = pick<HTMLSpanElement>("#word-count");
  const noteCountEl = pick<HTMLSpanElement>("#note-count");
  const saveDotEl = pick<HTMLSpanElement>("#save-dot");
  const saveLabelEl = pick<HTMLSpanElement>("#save-label");
  const paletteOverlay = pick<HTMLDivElement>("#palette-overlay");
  const paletteInput = pick<HTMLInputElement>("#palette-input");
  const paletteList = pick<HTMLDivElement>("#palette-list");
  const settingsOverlay = pick<HTMLDivElement>("#settings-overlay");
  const trashOverlay = pick<HTMLDivElement>("#trash-overlay");
  const trashList = pick<HTMLDivElement>("#trash-list");
  const trashCountEl = pick<HTMLSpanElement>("#trash-count");
  const trashDescEl = pick<HTMLSpanElement>("#trash-desc");
  const emptyTrashEl = pick<HTMLButtonElement>("#empty-trash");
  const toastEl = pick<HTMLDivElement>("#toast");
  const setShakeEl = pick<HTMLInputElement>("#set-shake");
  const setSensitivityEl = pick<HTMLInputElement>("#set-sensitivity");
  const setBlurEl = pick<HTMLInputElement>("#set-blur");
  const setAutostartEl = pick<HTMLInputElement>("#set-autostart");

  let paletteOpen = false;
  let paletteQuery = "";
  let paletteIndex = 0;
  let paletteItems: PaletteItem[] = [];
  let settingsOpen = false;
  let trashOpen = false;
  let toastTimer: number | undefined;
  let toastHideTimer: number | undefined;
  let saveTimer: number | undefined;
  let stickySyncTimer: number | undefined;
  const pendingStickyIds = new Set<string>();
  const history = new History();
  const viewStates = new Map<string, ViewState>();
  const confirmTimers = new WeakMap<HTMLButtonElement, number>();

  function renderTabs() {
    tabsEl.innerHTML = "";
    for (const note of store.notes()) {
      const tab = document.createElement("div");
      tab.className = `tab${note.id === store.doc.activeId ? " is-active" : ""}`;
      tab.setAttribute("role", "tab");
      tab.dataset.id = note.id;
      tab.tabIndex = -1;
      tab.title = note.title || "Untitled";

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
    saveLabelEl.textContent = "saved";
  }

  function markSaving() {
    saveDotEl.classList.add("is-saving");
    saveLabelEl.textContent = "saving…";
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(markSaved, 420);
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
        const note = store.doc.notes.find((value) => value.id === id);
        if (!note || note.closedAt) continue;
        void api.emitDocChanged({ id: note.id, title: note.title, body: note.body });
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

  function paletteActions(): PaletteItem[] {
    const query = paletteQuery.trim();
    const items: PaletteItem[] = [];

    if (query) {
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
    } else {
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
    }

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
    const noteItems: PaletteItem[] = searchNotes(store.doc.notes, query).map((match) => ({
      kind: "note",
      id: match.note.id,
      label: match.note.title,
      detail: match.note.closedAt ? "closed" : relativeTime(match.note.updatedAt),
      closed: Boolean(match.note.closedAt),
      titleHtml: highlight(match.note.title, match.titleRanges),
      snippetHtml: match.snippet ? highlight(match.snippet, match.snippetRanges) : "",
      action: () => {
        closePalette(false);
        selectNote(match.note.id);
      },
    }));
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
      row.innerHTML = `
        <span class="palette-icon">${item.kind === "note" ? (item.closed ? icons.archive : icons.note) : icons.bolt}</span>
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

  pick<HTMLButtonElement>("#new-note").addEventListener("click", () => addNote());
  pick<HTMLButtonElement>("#pin-note").addEventListener("click", () => togglePinActive());
  pick<HTMLButtonElement>("#open-palette").addEventListener("click", () => openPalette());
  pick<HTMLButtonElement>("#open-settings").addEventListener("click", () => {
    void openSettings();
  });
  pick<HTMLButtonElement>("#settings-close").addEventListener("click", () => closeSettings());
  pick<HTMLButtonElement>("#trash-close").addEventListener("click", () => closeTrash());
  pick<HTMLButtonElement>("#open-trash").addEventListener("click", () => openTrash());
  emptyTrashEl.addEventListener("click", () => {
    if (!armConfirm(emptyTrashEl, "sure?")) return;
    for (const note of store.trashed()) history.discard(note.id);
    store.emptyTrash();
    renderTrash();
    refreshTrashMeta();
    showToast("trash emptied");
  });
  pick<HTMLButtonElement>("#export-notes").addEventListener("click", () => {
    void exportNotes();
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
      store.flush();
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
    store.flush();
    markSaved();
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
    if (document.hidden) store.flush();
  });

  void api.onShown(pulseShell);
  void api.onShake(pulseShell);
  void api.setShakeEnabled(store.doc.settings.shakeEnabled);
  void api.setShakeSensitivity(store.doc.settings.shakeSensitivity);
  void api.setHideOnBlur(store.doc.settings.hideOnBlur);

  void api.onStickyEdit(({ id, body }) => {
    const note = store.doc.notes.find((value) => value.id === id);
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
    const note = store.doc.notes.find((value) => value.id === id);
    if (!note || note.closedAt) {
      void api.unpinNote(id);
      return;
    }
    void api.emitDocChanged({ id, title: note.title, body: note.body });
  });

  void api.onPinClosed((id) => {
    store.unpin(id);
    refreshPinButton();
  });

  for (const id of [...store.doc.settings.pinnedIds]) {
    const note = store.doc.notes.find((value) => value.id === id);
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
