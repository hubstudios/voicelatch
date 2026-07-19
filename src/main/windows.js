'use strict';

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const log = require('./log');

const OVERLAY_W = 340;
const OVERLAY_H = 84;

function overlayPosition() {
  // Anchor to the display the cursor is on — closest proxy for "where the
  // user is working" without native window-rect queries.
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = disp.workArea;
  return {
    x: Math.round(wa.x + (wa.width - OVERLAY_W) / 2),
    y: Math.round(wa.y + wa.height - OVERLAY_H - 28),
  };
}

function createOverlay() {
  const win = new BrowserWindow({
    width: OVERLAY_W,
    height: OVERLAY_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: true,
    focusable: false,          // never steal focus from the dictation target
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // waveform must animate while unfocused
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay', 'overlay.html'));
  return win;
}

function showOverlay(win) {
  const { x, y } = overlayPosition();
  win.setPosition(x, y);
  win.showInactive();
}

function createDashboard() {
  const win = new BrowserWindow({
    width: 1060,
    height: 740,
    minWidth: 880,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#12141c',
    title: 'VoiceLatch',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'dashboard-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'dashboard', 'dashboard.html'));
  win.on('page-title-updated', (e) => e.preventDefault());
  return win;
}

// Renderer death must never brick dictation: recreate and report.
function guardRenderer(win, name, recreate) {
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error(`${name} renderer gone:`, details.reason);
    recreate(details);
  });
}

module.exports = { createOverlay, createDashboard, showOverlay, overlayPosition, guardRenderer, OVERLAY_W, OVERLAY_H };
