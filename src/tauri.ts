import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { NoteColor } from "./types";

export interface StickyEditPayload {
  id: string;
  body: string;
}

export interface DocChangedPayload {
  id: string;
  title: string;
  body: string;
  color?: NoteColor;
  opacity: number;
  attachmentCount: number;
}

export interface SettingsChangedPayload {
  opacity: number;
}

export interface ImportedAttachment {
  id: string;
  name: string;
  ext: string;
  size: number;
  path: string;
  thumb: string;
}

export interface ResolvedAttachment {
  path: string | null;
  thumb: string | null;
}

export interface MarkdownFile {
  name: string;
  contents: string;
}

export const api = {
  show: () => invoke<void>("show_window"),
  hide: () => invoke<void>("hide_window"),
  quit: () => invoke<void>("quit_app"),
  exitNow: () => invoke<void>("exit_now"),
  setShakeEnabled: (enabled: boolean) => invoke<void>("set_shake_enabled", { enabled }),
  setShakeSensitivity: (value: number) => invoke<void>("set_shake_sensitivity", { value }),
  setHideOnBlur: (enabled: boolean) => invoke<void>("set_hide_on_blur", { enabled }),
  setPointerDown: (down: boolean) => invoke<void>("set_pointer_down", { down }),
  getAutostart: () => invoke<boolean>("get_autostart"),
  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),
  pinNote: (id: string, title: string) => invoke<void>("pin_note", { id, title }),
  unpinNote: (id: string) => invoke<void>("unpin_note", { id }),
  forgetPin: (id: string) => invoke<void>("forget_pin", { id }),
  loadDoc: () => invoke<unknown | null>("load_doc"),
  saveDoc: (doc: unknown) => invoke<void>("save_doc", { doc }),
  getNote: (id: string) => invoke<unknown | null>("get_note", { id }),
  saveLegacySnapshot: (contents: string) => invoke<string>("save_legacy_snapshot", { contents }),
  writeTextFile: (path: string, contents: string) =>
    invoke<void>("write_text_file", { path, contents }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  exportMarkdownDir: (dir: string, files: MarkdownFile[]) =>
    invoke<number>("export_markdown_dir", { dir, files }),
  openDataDir: () => invoke<void>("open_data_dir"),
  importAttachment: (path: string) => invoke<ImportedAttachment>("import_attachment", { path }),
  resolveAttachment: (id: string, ext: string) =>
    invoke<ResolvedAttachment>("resolve_attachment", { id, ext }),
  revealAttachment: (id: string, ext: string) => invoke<void>("reveal_attachment", { id, ext }),
  pruneAttachments: (keep: string[]) => invoke<number>("prune_attachments", { keep }),
  emitDocChanged: (payload: DocChangedPayload) => emit("mote://doc-changed", payload),
  emitSettingsChanged: (payload: SettingsChangedPayload) =>
    emit("mote://settings-changed", payload),
  onShown: (handler: () => void): Promise<UnlistenFn> => listen("mote://shown", handler),
  onShake: (handler: () => void): Promise<UnlistenFn> => listen("mote://shake", handler),
  onQuitRequested: (handler: () => void): Promise<UnlistenFn> =>
    listen("mote://quit-requested", handler),
  onStickyReady: (handler: (id: string) => void): Promise<UnlistenFn> =>
    listen<string>("mote://sticky-ready", (event) => handler(event.payload)),
  onStickyEdit: (handler: (payload: StickyEditPayload) => void): Promise<UnlistenFn> =>
    listen<StickyEditPayload>("mote://sticky-edit", (event) => handler(event.payload)),
  onPinClosed: (handler: (id: string) => void): Promise<UnlistenFn> =>
    listen<string>("mote://pin-closed", (event) => handler(event.payload)),
  onDocChanged: (handler: (payload: DocChangedPayload) => void): Promise<UnlistenFn> =>
    listen<DocChangedPayload>("mote://doc-changed", (event) => handler(event.payload)),
  onSettingsChanged: (handler: (payload: SettingsChangedPayload) => void): Promise<UnlistenFn> =>
    listen<SettingsChangedPayload>("mote://settings-changed", (event) => handler(event.payload)),
};
