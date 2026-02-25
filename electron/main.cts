import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, Notification } from 'electron';
import { ChildProcess, fork } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { autoUpdater, UpdateInfo } from 'electron-updater';

// Track quit intent (tray minimize vs real quit)
let isQuitting = false;

// Determine paths based on whether we're packaged or in dev
const isDev = !app.isPackaged;
const projectRoot = isDev
  ? path.resolve(__dirname, '..')
  : path.join(process.resourcesPath, 'app');

const WEB_PORT = process.env.WEB_PORT || '3100';
const distIndexPath = path.join(projectRoot, 'dist', 'index.js');
const envPath = path.join(projectRoot, '.env');
const preloadPath = path.join(__dirname, 'preload.cjs');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let botProcess: ChildProcess | null = null;
let botStatus: 'running' | 'stopped' | 'error' = 'stopped';

// ── Bot Process Management ──────────────────────────────────────────

function setBotStatus(status: 'running' | 'stopped' | 'error') {
  botStatus = status;
  mainWindow?.webContents.send('bot:status-changed', status);
  updateTrayMenu();
}

function sendLog(line: string) {
  mainWindow?.webContents.send('bot:log', line);
}

function startBot(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (botProcess) {
      resolve();
      return;
    }

    if (!fs.existsSync(distIndexPath)) {
      sendLog(`[electron] ERROR: Bot entry not found at ${distIndexPath}`);
      setBotStatus('error');
      reject(new Error('Bot entry not found'));
      return;
    }

    botProcess = fork(distIndexPath, [], {
      cwd: projectRoot,
      env: { ...process.env, WEB_PORT },
      silent: true,
    });

    botProcess.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      lines.forEach((line) => sendLog(line));
    });

    botProcess.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      lines.forEach((line) => sendLog(`[stderr] ${line}`));
    });

    botProcess.on('exit', (code) => {
      sendLog(`[electron] Bot process exited with code ${code}`);
      botProcess = null;
      setBotStatus(code === 0 ? 'stopped' : 'error');
    });

    botProcess.on('error', (err) => {
      sendLog(`[electron] Bot process error: ${err.message}`);
      botProcess = null;
      setBotStatus('error');
      reject(err);
    });

    setBotStatus('running');
    sendLog('[electron] Bot started');
    resolve();
  });
}

function stopBot(): Promise<void> {
  return new Promise((resolve) => {
    if (!botProcess) {
      setBotStatus('stopped');
      resolve();
      return;
    }

    const proc = botProcess;
    const timeout = setTimeout(() => {
      sendLog('[electron] Force-killing bot process');
      proc.kill('SIGKILL');
    }, 5000);

    proc.once('exit', () => {
      clearTimeout(timeout);
      botProcess = null;
      setBotStatus('stopped');
      resolve();
    });

    sendLog('[electron] Stopping bot (SIGTERM)...');
    proc.kill('SIGTERM');
  });
}

// ── IPC Handlers ────────────────────────────────────────────────────

ipcMain.handle('bot:get-status', () => botStatus);
ipcMain.handle('bot:start', () => startBot());
ipcMain.handle('bot:stop', () => stopBot());
ipcMain.handle('bot:restart', async () => {
  await stopBot();
  await startBot();
});

// ── Window ──────────────────────────────────────────────────────────

function createWindow() {
  const hasEnv = fs.existsSync(envPath);
  const startUrl = hasEnv
    ? `http://localhost:${WEB_PORT}`
    : `http://localhost:${WEB_PORT}/login.html`;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Alvin Bot',
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(startUrl);

  mainWindow.on('close', (event) => {
    // Minimize to tray instead of quitting
    if (tray && !isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Tray ────────────────────────────────────────────────────────────

function getTrayIconPath(): string {
  const buildDir = isDev
    ? path.join(projectRoot, 'build')
    : path.join(process.resourcesPath, 'build');

  // macOS uses Template images for dark/light mode support
  if (process.platform === 'darwin') {
    const templatePath = path.join(buildDir, 'tray-iconTemplate.png');
    if (fs.existsSync(templatePath)) return templatePath;
  }

  return path.join(buildDir, 'tray-icon.png');
}

function updateTrayMenu() {
  if (!tray) return;

  const statusLabel =
    botStatus === 'running' ? '● Running' :
    botStatus === 'error'   ? '⚠ Error' :
                              '○ Stopped';

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Alvin Bot', enabled: false },
    { type: 'separator' },
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    {
      label: 'Open Dashboard',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    {
      label: botStatus === 'running' ? 'Stop Bot' : 'Start Bot',
      click: () => {
        if (botStatus === 'running') {
          stopBot();
        } else {
          startBot();
        }
      },
    },
    { type: 'separator' },
    {
      label: updateStatus === 'checking' ? 'Checking for Updates...' :
             updateStatus === 'available' || updateStatus === 'downloading' ? 'Update Downloading...' :
             updateStatus === 'ready' ? '⬆ Install Update & Restart' :
             updateStatus === 'up-to-date' ? '✓ Up to Date' :
             'Check for Updates',
      enabled: updateStatus !== 'checking' && updateStatus !== 'downloading',
      click: () => {
        if (updateStatus === 'ready') {
          isQuitting = true;
          autoUpdater.quitAndInstall();
        } else if (app.isPackaged) {
          autoUpdater.checkForUpdatesAndNotify();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip(`Alvin Bot — ${statusLabel}`);
}

function createTray() {
  const iconPath = getTrayIconPath();
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  updateTrayMenu();

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

// ── Auto-Update ─────────────────────────────────────────────────────

type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error';
let updateStatus: UpdateStatus = 'idle';
let updateCheckInterval: ReturnType<typeof setInterval> | null = null;

function setUpdateStatus(status: UpdateStatus) {
  updateStatus = status;
  mainWindow?.webContents.send('update:status-changed', status);
  updateTrayMenu();
}

function setupAutoUpdater() {
  // Disable auto-update in dev mode
  if (!app.isPackaged) {
    sendLog('[electron] Auto-update disabled in dev mode');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    sendLog('[electron] Checking for updates...');
    setUpdateStatus('checking');
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    sendLog(`[electron] Update available: v${info.version}`);
    setUpdateStatus('available');
    mainWindow?.webContents.send('update:available', { version: info.version });
    if (Notification.isSupported()) {
      new Notification({
        title: 'Update Available',
        body: `Alvin Bot v${info.version} is available and downloading...`,
      }).show();
    }
  });

  autoUpdater.on('update-not-available', () => {
    sendLog('[electron] App is up to date');
    setUpdateStatus('up-to-date');
    // Reset to idle after 10s
    setTimeout(() => { if (updateStatus === 'up-to-date') setUpdateStatus('idle'); }, 10000);
  });

  autoUpdater.on('download-progress', (progress) => {
    setUpdateStatus('downloading');
    sendLog(`[electron] Download progress: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    sendLog(`[electron] Update downloaded: v${info.version}`);
    setUpdateStatus('ready');
    mainWindow?.webContents.send('update:downloaded', { version: info.version });
    if (mainWindow && mainWindow.isVisible()) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Ready',
        message: `Alvin Bot v${info.version} has been downloaded.`,
        detail: 'Restart now to install the update?',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) {
          isQuitting = true;
          autoUpdater.quitAndInstall();
        }
      });
    }
  });

  autoUpdater.on('error', (err) => {
    sendLog(`[electron] Auto-update error: ${err.message}`);
    setUpdateStatus('error');
    // Reset to idle after 30s
    setTimeout(() => { if (updateStatus === 'error') setUpdateStatus('idle'); }, 30000);
  });

  // Initial check
  autoUpdater.checkForUpdatesAndNotify();

  // Check every 4 hours
  updateCheckInterval = setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify();
  }, 4 * 60 * 60 * 1000);
}

// ── Update IPC Handlers ─────────────────────────────────────────────

ipcMain.handle('update:check', () => {
  if (!app.isPackaged) return { status: 'dev-mode' };
  autoUpdater.checkForUpdatesAndNotify();
  return { status: 'checking' };
});

ipcMain.handle('update:install', () => {
  if (updateStatus === 'ready') {
    isQuitting = true;
    autoUpdater.quitAndInstall();
  }
  return { status: updateStatus };
});

ipcMain.handle('update:get-status', () => updateStatus);

// ── App Lifecycle ───────────────────────────────────────────────────

app.on('ready', async () => {
  createTray();
  createWindow();
  setupAutoUpdater();

  // Auto-start bot if .env exists
  if (fs.existsSync(envPath)) {
    try {
      await startBot();
    } catch (err) {
      sendLog(`[electron] Failed to auto-start bot: ${err}`);
    }
  }
});

app.on('window-all-closed', () => {
  // On macOS, keep app running in tray
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (!mainWindow) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

app.on('before-quit', async () => {
  isQuitting = true;
  if (botProcess) {
    await stopBot();
  }
});
