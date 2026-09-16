import { mountApp } from "./app";
import { LEGACY_KEY, Store, welcomeDoc, type DocPersistence } from "./store";
import { api } from "./tauri";

const persistence: DocPersistence = {
  async load() {
    const fileDoc = await api.loadDoc();
    if (fileDoc) return fileDoc;
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (!legacy) return null;
    try {
      const snapshot = await api.saveLegacySnapshot(legacy);
      console.info("mote: archived legacy notes to", snapshot);
    } catch (error) {
      console.warn("mote: could not archive legacy notes", error);
    }
    try {
      return JSON.parse(legacy);
    } catch {
      return null;
    }
  },
  async save(doc) {
    await api.saveDoc(doc);
  },
};

async function boot() {
  let store: Store;
  try {
    store = await Store.open(persistence);
  } catch (error) {
    console.error("mote: could not load notes, starting in memory", error);
    store = new Store(welcomeDoc(), {
      load: async () => null,
      save: async () => {
        throw error;
      },
    });
    store.lastError = error;
  }

  mountApp(store);

  window.addEventListener("beforeunload", () => {
    void store.flush();
  });

  void api.onQuitRequested(async () => {
    try {
      await store.flush();
    } finally {
      void api.exitNow();
    }
  });

  if (!localStorage.getItem("mote.booted")) {
    localStorage.setItem("mote.booted", "1");
    void api.show();
  }
}

void boot();
