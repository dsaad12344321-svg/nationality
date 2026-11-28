"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type SharedFolderKind = "reservations" | "registration";
export type SharedFolderEntry = { path: string; relativePath: string; name: string; size: number; mtimeMs: number; rootPath?: string };
type FolderState = { path: string; entries: SharedFolderEntry[]; loading: boolean; loaded: boolean; error: string };
type FileLibraryContextValue = {
  reservations: FolderState; registrations: FolderState;
  refreshFolder: (kind: SharedFolderKind, rootPath?: string) => Promise<SharedFolderEntry[]>;
  setFolderPath: (kind: SharedFolderKind, rootPath: string) => Promise<SharedFolderEntry[]>;
  setFolderFiles: (kind: SharedFolderKind, files: File[]) => Promise<SharedFolderEntry[]>;
  readBytes: (kind: SharedFolderKind, entry: SharedFolderEntry) => Promise<Uint8Array>;
  getFile: (kind: SharedFolderKind, entry: SharedFolderEntry) => Promise<File>;
  getFiles: (kind: SharedFolderKind, entries?: SharedFolderEntry[]) => Promise<File[]>;
};
const emptyFolder: FolderState = { path: "", entries: [], loading: false, loaded: false, error: "" };
const DB_NAME = "nationality-file-library";
const DB_VERSION = 1;
const STORE_NAME = "browser-files";

function openFileDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("تعذر فتح مساحة حفظ الملفات في المتصفح."));
  });
}
async function persistBrowserFiles(kind: SharedFolderKind, files: File[]) {
  const db = await openFileDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item) {
          files.forEach((file, index) => {
            const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
            store.put({ id: kind + "|" + relativePath, kind, relativePath, name: file.name, size: file.size, mtimeMs: file.lastModified, blob: file });
          });
          return;
        }
        if ((item.value as { kind?: string }).kind === kind) item.delete();
        item.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("تعذر حفظ ملفات المجلد في المتصفح."));
      tx.onabort = () => reject(tx.error || new Error("تم إلغاء حفظ ملفات المجلد."));
    });
  } finally { db.close(); }
}
async function restoreBrowserFiles(kind: SharedFolderKind): Promise<{ path: string; entries: SharedFolderEntry[]; files: Map<string, File> }> {
  const db = await openFileDatabase();
  try {
    const rows = await new Promise<Array<{ relativePath: string; name: string; size: number; mtimeMs: number; blob: Blob }>>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve((request.result as Array<{ kind: string; relativePath: string; name: string; size: number; mtimeMs: number; blob: Blob }>).filter(row => row.kind === kind));
      request.onerror = () => reject(request.error || new Error("تعذر استعادة الملفات المحفوظة."));
    });
    const files = new Map<string, File>();
    const entries = rows.map(row => {
      const path = row.relativePath;
      files.set(kind + "|" + path, new File([row.blob], row.name, { lastModified: row.mtimeMs }));
      return { path, relativePath: path, name: row.name, size: row.size, mtimeMs: row.mtimeMs, rootPath: "browser-storage" };
    });
    const path = rows[0]?.relativePath.split("/")[0] || "";
    return { path, entries, files };
  } finally { db.close(); }
}
const FileLibraryContext = createContext<FileLibraryContextValue | null>(null);

export function FileLibraryProvider({ children }: { children: ReactNode }) {
  const [reservations, setReservations] = useState<FolderState>(emptyFolder);
  const [registrations, setRegistrations] = useState<FolderState>(emptyFolder);
  const folderStateRef = useRef({ reservations, registrations });
  useEffect(() => { folderStateRef.current = { reservations, registrations }; }, [reservations, registrations]);
  const browserFiles = useRef(new Map<string, File>());
  const byteCache = useRef(new Map<string, Uint8Array>());
  const cachedBytes = useRef(0);
  const maxCacheBytes = 256 * 1024 * 1024;
  const updateFolder = useCallback((kind: SharedFolderKind, updater: (current: FolderState) => FolderState) => {
    (kind === "reservations" ? setReservations : setRegistrations)(updater);
  }, []);

  const setFolderFiles = useCallback(async (kind: SharedFolderKind, files: File[]) => {
    const accepted = files.filter(file => file instanceof File && file.name.toLowerCase().endsWith(".pdf"));
    await persistBrowserFiles(kind, accepted);
    const prefix = kind + "|";
    for (const key of [...browserFiles.current.keys()]) if (key.startsWith(prefix)) browserFiles.current.delete(key);
    const entries = accepted.map((file, index) => {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const path = relativePath || file.name || String(index);
      browserFiles.current.set(prefix + path, file);
      return { path, relativePath, name: file.name, size: file.size, mtimeMs: file.lastModified, rootPath: "browser-storage" };
    });
    const label = accepted[0] && (accepted[0] as File & { webkitRelativePath?: string }).webkitRelativePath
      ? (accepted[0] as File & { webkitRelativePath?: string }).webkitRelativePath.split("/")[0]
      : "ملفات محددة من المتصفح";
    updateFolder(kind, () => ({ path: label, entries, loading: false, loaded: true, error: "" }));
    return entries;
  }, [updateFolder]);

  const refreshFolder = useCallback(async (kind: SharedFolderKind, requestedPath?: string) => {
    if (!window.desktopBridge) {
      if (requestedPath) return (kind === "reservations" ? folderStateRef.current.reservations : folderStateRef.current.registrations).entries;
      const restored = await restoreBrowserFiles(kind);
      restored.files.forEach((file, key) => browserFiles.current.set(key, file));
      updateFolder(kind, () => ({ path: restored.path, entries: restored.entries, loading: false, loaded: true, error: "" }));
      return restored.entries;
    }
    updateFolder(kind, current => ({ ...current, loading: true, error: "" }));
    try {
      const rootPath = requestedPath || (kind === "reservations"
        ? await window.desktopBridge.getSavedFolderPath()
        : await window.desktopBridge.getSavedRCExtractorFolderPath());
      if (!rootPath) { updateFolder(kind, () => ({ ...emptyFolder, loaded: true })); return []; }
      const listedEntries = await window.desktopBridge.listFolderFiles(rootPath);
      const entries = listedEntries.map(entry => ({ ...entry, rootPath }));
      updateFolder(kind, () => ({ path: rootPath, entries, loading: false, loaded: true, error: "" }));
      return entries;
    } catch (error) {
      const message = error instanceof Error ? error.message : "تعذر فحص المجلد.";
      updateFolder(kind, current => ({ ...current, loading: false, loaded: true, error: message }));
      throw error;
    } finally { updateFolder(kind, current => ({ ...current, loading: false })); }
  }, [updateFolder]);

  const setFolderPath = useCallback(async (kind: SharedFolderKind, rootPath: string) => {
    if (!window.desktopBridge) throw new Error("في المتصفح اختر المجلد من زر اختيار المجلد.");
    if (kind === "reservations") await window.desktopBridge.saveFolderPath(rootPath);
    else await window.desktopBridge.saveRCExtractorFolderPath(rootPath);
    return refreshFolder(kind, rootPath);
  }, [refreshFolder]);

  const readBytes = useCallback(async (kind: SharedFolderKind, entry: SharedFolderEntry) => {
    const key = kind + "|" + entry.path + "|" + entry.size + "|" + entry.mtimeMs;
    const cached = byteCache.current.get(key);
    if (cached) return cached.slice();
    let bytes: Uint8Array;
    if (window.desktopBridge) {
      const folder = kind === "reservations" ? reservations : registrations;
      const rootPath = entry.rootPath || folder.path;
      if (!rootPath) throw new Error("المجلد غير متاح حاليًا.");
      bytes = new Uint8Array(await window.desktopBridge.readFile(rootPath, entry.path));
    } else {
      const file = browserFiles.current.get(kind + "|" + entry.path);
      if (!file) throw new Error("الملف غير موجود في التخزين المحلي. أعد اختيار المجلد.");
      bytes = new Uint8Array(await file.arrayBuffer());
    }
    if (bytes.byteLength <= maxCacheBytes) {
      while (cachedBytes.current + bytes.byteLength > maxCacheBytes && byteCache.current.size) {
        const oldestKey = byteCache.current.keys().next().value as string | undefined;
        if (!oldestKey) break;
        const oldest = byteCache.current.get(oldestKey);
        if (oldest) cachedBytes.current -= oldest.byteLength;
        byteCache.current.delete(oldestKey);
      }
      byteCache.current.set(key, bytes); cachedBytes.current += bytes.byteLength;
    }
    return bytes.slice();
  }, [reservations, registrations]);

  const getFile = useCallback(async (kind: SharedFolderKind, entry: SharedFolderEntry) => {
    const bytes = await readBytes(kind, entry);
    return new File([bytes.buffer as ArrayBuffer], entry.name, { lastModified: entry.mtimeMs });
  }, [readBytes]);
  const getFiles = useCallback(async (kind: SharedFolderKind, selectedEntries?: SharedFolderEntry[]) => {
    const folder = kind === "reservations" ? reservations : registrations;
    return Promise.all((selectedEntries || folder.entries).map(entry => getFile(kind, entry)));
  }, [reservations, registrations, getFile]);

  useEffect(() => {
    if (window.desktopBridge) {
      void Promise.all([refreshFolder("reservations").catch(() => []), refreshFolder("registration").catch(() => [])]);
    } else {
      void Promise.all([refreshFolder("reservations").catch(() => []), refreshFolder("registration").catch(() => [])]);
    }
  }, [refreshFolder]);

  const value = useMemo(() => ({ reservations, registrations, refreshFolder, setFolderPath, setFolderFiles, readBytes, getFile, getFiles }),
    [reservations, registrations, refreshFolder, setFolderPath, setFolderFiles, readBytes, getFile, getFiles]);
  return <FileLibraryContext.Provider value={value}>{children}</FileLibraryContext.Provider>;
}
export function useFileLibrary() {
  const value = useContext(FileLibraryContext);
  if (!value) throw new Error("useFileLibrary must be used inside FileLibraryProvider");
  return value;
}
