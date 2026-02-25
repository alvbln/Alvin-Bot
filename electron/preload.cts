import { contextBridge, ipcRenderer } from 'electron';

export interface AlvinBotAPI {
  getStatus: () => Promise<'running' | 'stopped' | 'error'>;
  startBot: () => Promise<void>;
  stopBot: () => Promise<void>;
  restartBot: () => Promise<void>;
  onStatusChange: (callback: (status: string) => void) => () => void;
  onLog: (callback: (line: string) => void) => () => void;
  // Auto-Update
  checkForUpdates: () => Promise<{ status: string }>;
  installUpdate: () => Promise<{ status: string }>;
  getUpdateStatus: () => Promise<string>;
  onUpdateAvailable: (callback: (info: { version: string }) => void) => () => void;
  onUpdateDownloaded: (callback: (info: { version: string }) => void) => () => void;
  onUpdateStatusChange: (callback: (status: string) => void) => () => void;
}

contextBridge.exposeInMainWorld('alvinBot', {
  getStatus: () => ipcRenderer.invoke('bot:get-status'),
  startBot: () => ipcRenderer.invoke('bot:start'),
  stopBot: () => ipcRenderer.invoke('bot:stop'),
  restartBot: () => ipcRenderer.invoke('bot:restart'),
  onStatusChange: (callback: (status: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: string) => callback(status);
    ipcRenderer.on('bot:status-changed', listener);
    return () => {
      ipcRenderer.removeListener('bot:status-changed', listener);
    };
  },
  onLog: (callback: (line: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, line: string) => callback(line);
    ipcRenderer.on('bot:log', listener);
    return () => {
      ipcRenderer.removeListener('bot:log', listener);
    };
  },
  // Auto-Update
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getUpdateStatus: () => ipcRenderer.invoke('update:get-status'),
  onUpdateAvailable: (callback: (info: { version: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, info: { version: string }) => callback(info);
    ipcRenderer.on('update:available', listener);
    return () => { ipcRenderer.removeListener('update:available', listener); };
  },
  onUpdateDownloaded: (callback: (info: { version: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, info: { version: string }) => callback(info);
    ipcRenderer.on('update:downloaded', listener);
    return () => { ipcRenderer.removeListener('update:downloaded', listener); };
  },
  onUpdateStatusChange: (callback: (status: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: string) => callback(status);
    ipcRenderer.on('update:status-changed', listener);
    return () => { ipcRenderer.removeListener('update:status-changed', listener); };
  },
} satisfies AlvinBotAPI);
