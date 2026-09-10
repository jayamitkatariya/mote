import { mountApp, store } from "./app";
import { api } from "./tauri";

const booted = localStorage.getItem("mote.booted");
if (!booted) {
  localStorage.setItem("mote.booted", "1");
  void api.show();
}

mountApp();

window.addEventListener("beforeunload", () => store.flush());

void api.onQuitRequested(() => {
  store.flush();
  void api.exitNow();
});
