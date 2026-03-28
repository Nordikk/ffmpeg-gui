const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

const isDev = !app.isPackaged;

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#0b0e11',
    title: 'FFmpeg Forge',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    window.loadURL(process.env.VITE_DEV_SERVER_URL);
    window.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
  window.loadURL(pathToFileURL(indexPath).toString());
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr || stdout || `Command failed with exit code ${code}`));
    });
  });
}

function formatOutputPath(inputPath, extension) {
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}_trim.${extension}`);
}

ipcMain.handle('desktop:open-file', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Quelldatei waehlen',
    properties: ['openFile'],
    filters: [
      {
        name: 'Media',
        extensions: ['mp4', 'mkv', 'mov', 'avi', 'mp3', 'wav', 'm4a', 'flac', 'webm']
      },
      {
        name: 'Alle Dateien',
        extensions: ['*']
      }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle('desktop:save-file', async (_event, sourcePath, extension) => {
  const result = await dialog.showSaveDialog({
    title: 'Ausgabedatei waehlen',
    defaultPath: formatOutputPath(sourcePath, extension),
    filters: [
      {
        name: extension.toUpperCase(),
        extensions: [extension]
      }
    ]
  });

  if (result.canceled || !result.filePath) {
    return null;
  }

  return result.filePath;
});

ipcMain.handle('desktop:probe-media', async (_event, filePath) => {
  const { stdout } = await runCommand('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath
  ]);

  return JSON.parse(stdout);
});

ipcMain.handle('desktop:run-lossless-cut', async (_event, payload) => {
  const args = ['-y'];

  if (payload.start) {
    args.push('-ss', payload.start);
  }

  if (payload.end) {
    args.push('-to', payload.end);
  }

  args.push('-i', payload.sourcePath, '-c:v', payload.videoCodec, '-c:a', payload.audioCodec, payload.outputPath);

  const result = await runCommand('ffmpeg', args);

  return {
    command: ['ffmpeg', ...args].join(' '),
    log: result.stderr || result.stdout
  };
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
