const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const logFile = path.join(process.cwd(), 'electron-control.log');

function log(message) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}\n`;
  console.log(logEntry.trim());
  fs.appendFileSync(logFile, logEntry);
}

log('Control app starting');
log(`Electron version: ${process.versions.electron}`);
log(`Chrome version: ${process.versions.chrome}`);
log(`Node version: ${process.versions.node}`);
log(`Platform: ${process.platform}`);
log(`Arch: ${process.arch}`);

// Process-level error handlers
process.on('uncaughtException', (error) => {
  log(`UNCAUGHT EXCEPTION: ${error.message}`);
  log(`Stack: ${error.stack}`);
});

process.on('unhandledRejection', (reason) => {
  log(`UNHANDLED REJECTION: ${reason}`);
});

// App events
app.on('before-quit', () => {
  log('APP: before-quit');
});

app.on('will-quit', () => {
  log('APP: will-quit');
});

app.on('quit', (event, exitCode) => {
  log(`APP: quit with exit code ${exitCode}`);
});

app.on('window-all-closed', () => {
  log('APP: window-all-closed');
  app.quit();
});

app.on('render-process-gone', (event, webContents, details) => {
  log(`APP: render-process-gone - reason: ${details.reason}, exitCode: ${details.exitCode}`);
});

app.on('child-process-gone', (event, details) => {
  log(`APP: child-process-gone - type: ${details.type}, reason: ${details.reason}, exitCode: ${details.exitCode}`);
});

app.on('gpu-process-crashed', (event, killed) => {
  log(`APP: gpu-process-crashed - killed: ${killed}`);
});

function createWindow() {
  log('Creating window');
  
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  });
  
  win.once('ready-to-show', () => {
    log('WINDOW: ready-to-show');
    win.show();
    log('WINDOW: shown');
  });
  
  win.on('close', () => {
    log('WINDOW: close');
  });
  
  win.on('closed', () => {
    log('WINDOW: closed');
  });
  
  win.on('unresponsive', () => {
    log('WINDOW: unresponsive');
  });
  
  win.webContents.on('crashed', (event, killed) => {
    log(`WEBCONTENTS: crashed - killed: ${killed}`);
  });
  
  win.webContents.on('render-process-gone', (event, details) => {
    log(`WEBCONTENTS: render-process-gone - reason: ${details.reason}, exitCode: ${details.exitCode}`);
  });
  
  win.webContents.on('did-finish-load', () => {
    log('WEBCONTENTS: did-finish-load');
  });
  
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    log(`WEBCONTENTS: did-fail-load - code: ${errorCode}, desc: ${errorDescription}`);
  });
  
  const html = `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <title>Electron Control Test</title>
    <style>
      body {
        font-family: system-ui, -apple-system, sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
      }
      .container {
        text-align: center;
      }
      h1 {
        font-size: 48px;
        margin: 0 0 20px 0;
      }
      p {
        font-size: 20px;
        opacity: 0.9;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>✓ Electron Control Test</h1>
      <p>Electron ${process.versions.electron}</p>
      <p>If you see this, the window is rendering correctly</p>
    </div>
  </body>
</html>
  `;
  
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  
  log('Window created and loading HTML');
}

app.whenReady().then(() => {
  log('App ready');
  createWindow();
});

log('Main script executed');
