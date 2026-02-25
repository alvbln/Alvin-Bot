import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } from 'electron';
import { ChildProcess, fork } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

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
const preloadPath = path.join(__dirname, 'preload.js');

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

// ── App Lifecycle ───────────────────────────────────────────────────

app.on('ready', async () => {
  createTray();
  createWindow();

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
