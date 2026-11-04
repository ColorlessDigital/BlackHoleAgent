import path from 'path';
import { BrowserWindow } from 'electron';
import { PROJECT_ROOT } from '../common/paths.js';

export function createMainWindow(apiInfo) {
  const window = new BrowserWindow({
    title: 'BlackHole',
    width: 1380,
    height: 860,
    minWidth: 1120,
    minHeight: 720,
    center: true,
    frame: false,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    thickFrame: true,
    show: true,
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: path.join(PROJECT_ROOT, 'src', 'main', 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  window.show();
  window.focus();

  window.once('ready-to-show', () => {
    window.show();
    window.focus();
  });

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Electron] Failed to load URL: ${validatedURL} (${errorCode}: ${errorDescription})`);
  });

  const devUrl = process.env.BLACKHOLE_VITE_URL;
  if (devUrl) {
    window.loadURL(devUrl).catch(() => window.loadURL(apiInfo.baseUrl));
  } else {
    window.loadURL(apiInfo.baseUrl);
  }
  return window;
}
