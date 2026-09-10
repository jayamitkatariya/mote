import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface StickyEditPayload {
  id: string;
  body: string;
}

export interface DocChangedPayload {
  id: string;
  title: string;
  body: string;
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
  emitDocChanged: (payload: DocChangedPayload) => emit("mote://doc-changed", payload),
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
};
