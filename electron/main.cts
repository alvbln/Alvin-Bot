import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, Notification } from 'electron';
import { ChildProcess, fork } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
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

// ── Wait for Server ─────────────────────────────────────────────────

function waitForServer(port: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      if (Date.now() - start > timeoutMs) {
        sendLog('[electron] Server startup timed out');
        resolve(false);
        return;
      }
      const req = http.get(`http://localhost:${port}/`, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        setTimeout(check, 300);
      });
      req.setTimeout(1000, () => {
        req.destroy();
        setTimeout(check, 300);
      });
    };
    check();
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

function getSetupPagePath(): string {
  const setupInBuild = isDev
    ? path.join(projectRoot, 'build', 'setup.html')
    : path.join(process.resourcesPath, 'build', 'setup.html');
  return setupInBuild;
}

function createWindow() {
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

  // Don't load URL yet — app.on('ready') handles that after bot startup
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

async function loadWindowContent() {
  if (!mainWindow) return;

  const hasEnv = fs.existsSync(envPath);

  if (!hasEnv) {
    // No .env → show local setup page (no server needed)
    const setupPath = getSetupPagePath();
    if (fs.existsSync(setupPath)) {
      mainWindow.loadFile(setupPath);
    } else {
      // Fallback: inline HTML
      mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
        <!DOCTYPE html><html><head><meta charset="utf-8">
        <style>body{font-family:-apple-system,sans-serif;background:#0f0f0f;color:#e0e0e0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
        .c{text-align:center;max-width:480px;padding:40px}.c h1{margin-bottom:16px}.c p{color:#888;line-height:1.6}
        code{background:#242424;padding:2px 8px;border-radius:4px;font-size:0.9em}</style></head>
        <body><div class="c"><h1>🤖 Alvin Bot</h1>
        <p>No <code>.env</code> file found.<br><br>
        Create a <code>.env</code> file in the app directory with your bot configuration, then restart the app.<br><br>
        Run <code>alvin-bot setup</code> in terminal for guided setup.</p></div></body></html>
      `)}`);
    }
    return;
  }

  // Has .env → bot should be running, wait for server
  sendLog('[electron] Waiting for web server...');
  const serverReady = await waitForServer(WEB_PORT);

  if (serverReady) {
    mainWindow.loadURL(`http://localhost:${WEB_PORT}`);
  } else {
    // Server didn't start in time — show error with retry
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <!DOCTYPE html><html><head><meta charset="utf-8">
      <style>body{font-family:-apple-system,sans-serif;background:#0f0f0f;color:#e0e0e0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
      .c{text-align:center;max-width:480px;padding:40px}.c h1{margin-bottom:16px}.c p{color:#888;line-height:1.6}
      button{background:#6c5ce7;color:white;border:none;border-radius:8px;padding:12px 24px;font-size:1em;cursor:pointer;margin-top:16px}
      button:hover{opacity:0.9}</style></head>
      <body><div class="c"><h1>⚠️ Server Timeout</h1>
      <p>The bot server didn't start in time. Check your <code>.env</code> configuration and logs.</p>
      <button onclick="location.reload()">Retry</button></div></body></html>
    `)}`);
  }
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

  // Auto-start bot if .env exists, THEN load window content
  if (fs.existsSync(envPath)) {
    try {
      await startBot();
    } catch (err) {
      sendLog(`[electron] Failed to auto-start bot: ${err}`);
    }
  }

  // Load content after bot has had a chance to start
  await loadWindowContent();
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
