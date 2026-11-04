import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { startApiServer } from '../server/apiGateway.js';
import { createMainWindow } from './electronWindow.js';

const isMcpServerMode = process.argv.includes('--mcp-server');

if (isMcpServerMode) {
  await import('../mcp/blackholeMcpServer.js');
} else {
  let mainWindow = null;
  let apiInfo = null;

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    process.exit(0);
  }

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    console.log('[Electron] app.whenReady fired');
    try {
      console.log('[Electron] starting api server...');
      apiInfo = await startApiServer({ port: 3003 });
      console.log('[Electron] api server ready:', apiInfo.baseUrl);
      mainWindow = createMainWindow(apiInfo);
      console.log('[Electron] mainWindow created successfully');
    } catch (error) {
      console.error('[Electron] startup failed:', error);
      dialog.showErrorBox('BlackHole startup failed', error?.stack || error?.message || String(error));
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && apiInfo) {
      mainWindow = createMainWindow(apiInfo);
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  ipcMain.handle('blackhole:getApiConfig', () => apiInfo);
  ipcMain.handle('blackhole:selectWorkspace', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select workspace directory',
      properties: ['openDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('blackhole:selectLlamaServer', async () => {
    const options = {
      title: process.platform === 'win32' ? 'Select llama-server.exe' : 'Select llama-server',
      properties: ['openFile']
    };
    if (process.platform === 'win32') {
      options.filters = [{ name: 'llama-server', extensions: ['exe'] }];
    }
    const result = await dialog.showOpenDialog(mainWindow, options);
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('blackhole:selectGgufModel', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select GGUF model',
      properties: ['openFile'],
      filters: [{ name: 'GGUF model', extensions: ['gguf'] }]
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.on('blackhole:minimize', () => mainWindow?.minimize());
  ipcMain.on('blackhole:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('blackhole:close', () => mainWindow?.close());
}
