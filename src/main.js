const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const scriptsDir = path.join(__dirname, 'scripts');
const runningProcesses = new Map();

function buildPowerShellArgs(scriptArgs) {
  if (!scriptArgs || typeof scriptArgs !== 'object') {
    return [];
  }

  const args = [];

  Object.entries(scriptArgs).forEach(([key, rawValue]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid script argument name: ${key}`);
    }

    if (rawValue === undefined || rawValue === null) {
      return;
    }

    const value = String(rawValue);
    if (value.includes('\n') || value.includes('\r')) {
      throw new Error(`Invalid script argument value for: ${key}`);
    }

    args.push(`-${key}`, value);
  });

  return args;
}

function stopProcessTree(pid) {
  if (!pid) {
    return;
  }

  const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  killer.on('error', () => {
  });
}

function extractReadHostPrompts(scriptContent) {
  const prompts = [];
  const regexes = [
    /Read-Host\s+-Prompt\s+['"]([^'"]+)['"]/gi,
    /Read-Host\s+['"]([^'"]+)['"]/gi,
  ];

  regexes.forEach((regex) => {
    let match = regex.exec(scriptContent);
    while (match) {
      prompts.push(match[1].trim());
      match = regex.exec(scriptContent);
    }
  });

  return [...new Set(prompts)].filter(Boolean);
}

async function getScriptPrompts(scriptPath) {
  try {
    const scriptContent = await fs.promises.readFile(scriptPath, 'utf8');
    return extractReadHostPrompts(scriptContent);
  } catch {
    return [];
  }
}

function emitPromptLine(webContents, promptText) {
  const text = promptText.endsWith(':') ? promptText : `${promptText}:`;
  webContents.send('script-output', `${text}\n`);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 500,
    minWidth: 980,
    minHeight: 500,
    maxWidth: 980,
    maxHeight: 500,
    resizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);

ipcMain.handle('get-scripts', async () => {
  const files = await fs.promises.readdir(scriptsDir);
  return files.filter((fileName) => fileName.endsWith('.ps1') || fileName.endsWith('.js'));
});

ipcMain.handle('run-script', async (event, runRequest) => {
  if (runningProcesses.has(event.sender.id)) {
    throw new Error('Another script is already running');
  }

  const request = typeof runRequest === 'string'
    ? { scriptName: runRequest, scriptArgs: {} }
    : runRequest;

  const scriptName = request?.scriptName;
  const scriptArgs = request?.scriptArgs || {};

  if (typeof scriptName !== 'string' || scriptName.includes('..') || scriptName.includes('/') || scriptName.includes('\\')) {
    throw new Error('Invalid script name');
  }

  const scriptPath = path.join(scriptsDir, scriptName);
  const exists = await fs.promises
    .access(scriptPath)
    .then(() => true)
    .catch(() => false);

  if (!exists) {
    throw new Error('Script not found');
  }

  const isPowerShellScript = scriptName.endsWith('.ps1');
  const prompts = isPowerShellScript ? await getScriptPrompts(scriptPath) : [];

  return await new Promise((resolve, reject) => {
    const command = isPowerShellScript ? 'powershell.exe' : 'node';
    const args = isPowerShellScript
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...buildPowerShellArgs(scriptArgs)]
      : [scriptPath];

    const childProcess = spawn(command, args, { windowsHide: true });
    runningProcesses.set(event.sender.id, {
      childProcess,
      prompts,
      promptIndex: 0,
      stopping: false,
    });
    event.sender.send('script-state', { running: true, scriptName });

    if (prompts.length > 0) {
      emitPromptLine(event.sender, prompts[0]);
    }

    childProcess.stdout.on('data', (chunk) => {
      event.sender.send('script-output', chunk.toString());
    });

    childProcess.stderr.on('data', (chunk) => {
      event.sender.send('script-output', `stderr: ${chunk.toString()}`);
    });

    childProcess.on('error', (error) => {
      runningProcesses.delete(event.sender.id);
      event.sender.send('script-state', { running: false, scriptName });
      reject(new Error(error.message));
    });

    childProcess.on('close', (code) => {
      const processEntry = runningProcesses.get(event.sender.id);
      const wasStoppedByUser = !!processEntry?.stopping;

      runningProcesses.delete(event.sender.id);
      event.sender.send('script-state', { running: false, scriptName });

      if (wasStoppedByUser) {
        resolve({ stopped: true, exitCode: code });
        return;
      }

      if (code === 0) {
        resolve({ exitCode: code });
        return;
      }

      reject(new Error(`Process exited with code ${code}`));
    });
  });
});

ipcMain.on('send-script-input', (event, input) => {
  const processEntry = runningProcesses.get(event.sender.id);
  const childProcess = processEntry?.childProcess;

  if (!childProcess || childProcess.killed) {
    event.sender.send('script-output', 'No running script to receive input.');
    return;
  }

  childProcess.stdin.write(`${input ?? ''}\n`);

  if (processEntry.prompts.length > 0) {
    processEntry.promptIndex += 1;
    const nextPrompt = processEntry.prompts[processEntry.promptIndex];
    if (nextPrompt) {
      emitPromptLine(event.sender, nextPrompt);
    }
  }
});

ipcMain.on('stop-script', (event) => {
  const processEntry = runningProcesses.get(event.sender.id);
  const childProcess = processEntry?.childProcess;

  if (!childProcess || childProcess.killed) {
    event.sender.send('script-output', 'No running script to stop.');
    return;
  }

  processEntry.stopping = true;
  event.sender.send('script-output', 'Stopping script...');

  try {
    childProcess.stdin.write('\x03');
  } catch {
  }

  setTimeout(() => {
    if (!childProcess.killed && childProcess.exitCode === null) {
      stopProcessTree(childProcess.pid);
    }
  }, 300);
});