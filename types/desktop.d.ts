export {};
declare global {
  interface Window {
    desktopBridge?: {
      getSavedFolderPath: () => Promise<string>;
      getSavedRCExtractorFolderPath: () => Promise<string>;
      saveRCExtractorFolderPath: (rootPath: string) => Promise<boolean>;
      saveFolderPath: (rootPath: string) => Promise<boolean>;
      clearSavedFolderPath: () => Promise<boolean>;
      getAppInfo: () => Promise<{ name: string; version: string; packaged: boolean; platform: string }>;
      selectFiles: (extensions?: string[]) => Promise<string[]>;
      selectFolder: () => Promise<string | null>;
      listFolderFiles: (rootPath: string) => Promise<Array<{ path: string; relativePath: string; name: string; size: number; mtimeMs: number }>>;
      readFile: (rootPath: string, filePath: string) => Promise<Uint8Array>;
      openPath: (selectedPath: string) => Promise<boolean>;
      watchFolder: (rootPath: string) => Promise<boolean>;
      unwatchFolder: () => Promise<boolean>;
      onFolderChanged: (callback: () => void) => () => void;
      showInFolder: (selectedPath: string) => Promise<boolean>;
    };
  }
}
