"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type SharedFolderKind = "reservations" | "registration";
export type SharedFolderEntry = {
  path: string;
  relativePath: string;
  name: string;
  size: number;
  mtimeMs: number;
  rootPath?: string;
};
type FolderState = {
  path: string;
  entries: SharedFolderEntry[];
  loading: boolean;
  loaded: boolean;
  error: string;
};
type FileLibraryContextValue = {
  reservations: FolderState;
  registrations: FolderState;
  refreshFolder: (kind: SharedFolderKind, rootPath?: string) => Promise<SharedFolderEntry[]>;
  setFolderPath: (kind: SharedFolderKind, rootPath: string) => Promise<SharedFolderEntry[]>;
  setFolderFiles: (kind: SharedFolderKind, files: File[]) => SharedFolderEntry[];
  readBytes: (kind: SharedFolderKind, entry: SharedFolderEntry) => Promise<Uint8Array>;
  getFile: (kind: SharedFolderKind, entry: SharedFolderEntry) => Promise<File>;
  getFiles: (kind: SharedFolderKind, entries?: SharedFolderEntry[]) => Promise<File[]>;
};
const emptyFolder: FolderState = { path: "", entries: [], loading: false, loaded: false, error: "" };
const FileLibraryContext = createContext<FileLibraryContextValue | null>(null);

export function FileLibraryProvider({ children }: { children: ReactNode }) {
  const [reservations, setReservations] = useState<FolderState>(emptyFolder);
  const [registrations, setRegistrations] = useState<FolderState>(emptyFolder);
  const browserFiles = useRef(new Map<string, File>());
  const byteCache = useRef(new Map<string, Uint8Array>());
  const cachedBytes = useRef(0);
  const maxCacheBytes = 256 * 1024 * 1024;
  const updateFolder = useCallback((kind: SharedFolderKind, updater: (current: FolderState) => FolderState) => {
    (kind === "reservations" ? setReservations : setRegistrations)(updater);
  }, []);

  const setFolderFiles = useCallback((kind: SharedFolderKind, files: File[]) => {
    const prefix = kind + "|";
    for (const key of [...browserFiles.current.keys()]) if (key.startsWith(prefix)) browserFiles.current.delete(key);
    const entries = files.filter(file => file instanceof File).map((file, index) => {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const path = relativePath || file.name || String(index);
      browserFiles.current.set(prefix + path, file);
      return { path, relativePath, name: file.name, size: file.size, mtimeMs: file.lastModified, rootPath: "browser-session" };
    });
    const label = files[0] && (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath
      ? (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath.split("/")[0]
      : "ملفات محددة من المتصفح";
    updateFolder(kind, () => ({ path: label, entries, loading: false, loaded: true, error: "" }));
    return entries;
  }, [updateFolder]);

  const refreshFolder = useCallback(async (kind: SharedFolderKind, requestedPath?: string) => {
    if (!window.desktopBridge) {
      const current = kind === "reservations" ? reservations : registrations;
      if (requestedPath || !current.loaded) {
        updateFolder(kind, value => ({ ...value, loading: false, loaded: true, error: current.entries.length ? "" : "اختر مجلدًا أو ملفات من جهازك لبدء الفهرسة." }));
      }
      return current.entries;
    }
    updateFolder(kind, current => ({ ...current, loading: true, error: "" }));
    try {
      const rootPath = requestedPath || (kind === "reservations"
        ? await window.desktopBridge.getSavedFolderPath()
        : await window.desktopBridge.getSavedRCExtractorFolderPath());
      if (!rootPath) {
        updateFolder(kind, () => ({ ...emptyFolder, loaded: true }));
        return [];
      }
      const listedEntries = await window.desktopBridge.listFolderFiles(rootPath);
      const entries = listedEntries.map(entry => ({ ...entry, rootPath }));
      updateFolder(kind, () => ({ path: rootPath, entries, loading: false, loaded: true, error: "" }));
      return entries;
    } catch (error) {
      const message = error instanceof Error ? error.message : "تعذر فحص المجلد.";
      updateFolder(kind, current => ({ ...current, loading: false, loaded: true, error: message }));
      throw error;
    } finally {
      updateFolder(kind, current => ({ ...current, loading: false }));
    }
  }, [updateFolder, reservations, registrations]);

  const setFolderPath = useCallback(async (kind: SharedFolderKind, rootPath: string) => {
    if (!window.desktopBridge) throw new Error("في المتصفح اختر المجلد من زر اختيار الملفات بدلًا من إدخال مسار Windows.");
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
      if (!file) throw new Error("انتهت جلسة الملفات. أعد اختيار المجلد أو الملفات من جهازك.");
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
      byteCache.current.set(key, bytes);
      cachedBytes.current += bytes.byteLength;
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
    if (!window.desktopBridge) return;
    void Promise.all([
      refreshFolder("reservations").catch(() => []),
      refreshFolder("registration").catch(() => []),
    ]);
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
