const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const appIconPath = path.join(__dirname, '..', 'build', 'icon.png');
const runningProcesses = new Map();

function getScriptsDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'scripts');
  }

  return path.join(__dirname, 'scripts');
}

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

function runCommandAndCollect(command, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const shell = process.env.ComSpec || 'cmd.exe';
    const childProcess = spawn(shell, ['/d', '/s', '/c', command], { windowsHide: true });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      try {
        childProcess.kill();
      } catch {
      }
      reject(new Error('MFA command timed out'));
    }, timeoutMs);

    childProcess.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    childProcess.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    childProcess.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    childProcess.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr || `MFA command exited with code ${code}`));
        return;
      }

      resolve(stdout);
    });
  });
}

function decodeBase32(base32Value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = String(base32Value || '')
    .toUpperCase()
    .replace(/=+$/g, '')
    .replace(/\s+/g, '');

  let bits = '';
  for (const char of normalized) {
    const value = alphabet.indexOf(char);
    if (value === -1) {
      throw new Error('Invalid MFA secret format (expected Base32)');
    }
    bits += value.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }

  return Buffer.from(bytes);
}

function generateTotpCode(base32Secret, timestampMs = Date.now()) {
  const secret = decodeBase32(base32Secret);
  if (secret.length === 0) {
    throw new Error('MFA secret is empty');
  }

  const counter = Math.floor(timestampMs / 30000);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', secret).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binaryCode = (
    ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff)
  );

  return String(binaryCode % 1000000).padStart(6, '0');
}

function parseIniSections(fileContent) {
  const sections = new Map();
  let currentSection = '';
  sections.set(currentSection, []);

  String(fileContent || '').split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      return;
    }

    const sectionMatch = line.match(/^\[(.+)]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (!sections.has(currentSection)) {
        sections.set(currentSection, []);
      }
      return;
    }

    sections.get(currentSection).push(line);
  });

  return sections;
}

function extractMfaSecretFromLines(lines) {
  for (const line of lines || []) {
    const match = line.match(/^mfa_secret\s*=\s*(.+)$/i);
    if (match) {
      const value = match[1].trim();
      if (value) {
        return value;
      }
    }
  }

  return '';
}

async function readFileIfExists(filePath) {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function discoverMfaSecret(autoMfaContext) {
  const userHome = process.env.USERPROFILE || process.env.HOME || '';
  const profileName = String(autoMfaContext?.targetProfileName || '').trim();

  const localSecretFile = userHome
    ? path.join(userHome, '.electroscript', 'mfa.secret')
    : '';
  const localSecretJson = userHome
    ? path.join(userHome, '.electroscript', 'mfa.json')
    : '';
  const awsConfigFile = userHome
    ? path.join(userHome, '.aws', 'config')
    : '';
  const awsCredentialsFile = userHome
    ? path.join(userHome, '.aws', 'credentials')
    : '';

  if (localSecretFile) {
    const secretFromText = (await readFileIfExists(localSecretFile)).trim();
    if (secretFromText) {
      return { secret: secretFromText, source: localSecretFile };
    }
  }

  if (localSecretJson) {
    const secretJsonRaw = await readFileIfExists(localSecretJson);
    if (secretJsonRaw) {
      try {
        const parsed = JSON.parse(secretJsonRaw);
        const profileSecrets = parsed?.profiles && typeof parsed.profiles === 'object'
          ? parsed.profiles
          : {};
        const secretFromProfile = profileName
          ? String(profileSecrets[profileName] || '').trim()
          : '';
        const secretFromGlobal = String(parsed?.mfaSecret || parsed?.secret || '').trim();
        const discovered = secretFromProfile || secretFromGlobal;

        if (discovered) {
          const sourceSuffix = secretFromProfile ? `#profiles.${profileName}` : '#mfaSecret';
          return { secret: discovered, source: `${localSecretJson}${sourceSuffix}` };
        }
      } catch {
      }
    }
  }

  const awsConfigRaw = await readFileIfExists(awsConfigFile);
  if (awsConfigRaw) {
    const sections = parseIniSections(awsConfigRaw);
    const sectionNames = profileName
      ? [`profile ${profileName}`, profileName, 'default']
      : ['default'];

    for (const sectionName of sectionNames) {
      const lines = sections.get(sectionName) || [];
      const secret = extractMfaSecretFromLines(lines);
      if (secret) {
        return { secret, source: `${awsConfigFile}[${sectionName}]` };
      }
    }
  }

  const awsCredentialsRaw = await readFileIfExists(awsCredentialsFile);
  if (awsCredentialsRaw) {
    const sections = parseIniSections(awsCredentialsRaw);
    const sectionNames = profileName ? [profileName, 'default'] : ['default'];

    for (const sectionName of sectionNames) {
      const lines = sections.get(sectionName) || [];
      const secret = extractMfaSecretFromLines(lines);
      if (secret) {
        return { secret, source: `${awsCredentialsFile}[${sectionName}]` };
      }
    }
  }

  return null;
}

async function resolveAutoMfaCode(override, autoMfaContext) {
  const safeOverride = override && typeof override === 'object' ? override : {};
  const directMfa = String(safeOverride.mfaCode || process.env.ELECTROSCRIPT_MFA_CODE || '').trim();
  if (/^\d{6}$/.test(directMfa)) {
    return {
      code: directMfa,
      source: safeOverride.mfaCode ? 'ui.mfaCode' : 'ELECTROSCRIPT_MFA_CODE',
    };
  }

  const discoveredSecret = await discoverMfaSecret(autoMfaContext);
  const mfaSecretSource = safeOverride.mfaSecret
    ? 'ui.mfaSecret'
    : (process.env.ELECTROSCRIPT_MFA_SECRET ? 'ELECTROSCRIPT_MFA_SECRET' : discoveredSecret?.source);
  const mfaSecret = String(
    safeOverride.mfaSecret
    || process.env.ELECTROSCRIPT_MFA_SECRET
    || discoveredSecret?.secret
    || '',
  ).trim();

  if (mfaSecret) {
    return {
      code: generateTotpCode(mfaSecret),
      source: mfaSecretSource,
    };
  }

  const mfaCommand = String(safeOverride.mfaCommand || process.env.ELECTROSCRIPT_MFA_COMMAND || '').trim();
  if (!mfaCommand) {
    throw new Error('Auto MFA is not configured. AWS does not expose existing MFA seeds after setup. Provide a secret/command in settings, set ELECTROSCRIPT_MFA_SECRET, or add mfa_secret to your AWS profile config.');
  }

  const commandOutput = await runCommandAndCollect(mfaCommand);
  const matches = commandOutput.match(/\b\d{6}\b/g);
  if (!matches || matches.length === 0) {
    throw new Error('No 6-digit MFA code found in command output');
  }

  return {
    code: matches[matches.length - 1],
    source: safeOverride.mfaCommand ? 'ui.mfaCommand' : 'ELECTROSCRIPT_MFA_COMMAND',
  };
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

async function tryAutoMfa(processEntry, webContents) {
  if (!processEntry || processEntry.autoMfaAttempted) {
    return;
  }

  processEntry.autoMfaAttempted = true;

  try {
    const { code } = await resolveAutoMfaCode(processEntry.autoMfaOverride, processEntry.autoMfaContext);
    processEntry.childProcess.stdin.write(`${code}\n`);
    webContents.send('script-output', 'Auto MFA code sent.\n');
  } catch (error) {
    webContents.send('script-output', `Auto MFA unavailable: ${error.message || error}\n`);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 980,
    minHeight: 680,
    maxWidth: 980,
    maxHeight: 680,
    resizable: false,
    icon: fs.existsSync(appIconPath) ? appIconPath : undefined,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.ofir.electroscript');
}

app.whenReady().then(createWindow);

ipcMain.handle('get-auto-mfa', async (event, override) => {
  const payload = override && typeof override === 'object' ? override : {};
  const effectiveOverride = payload.override && typeof payload.override === 'object'
    ? payload.override
    : payload;
  const autoMfaContext = payload.context && typeof payload.context === 'object'
    ? payload.context
    : {};

  return await resolveAutoMfaCode(effectiveOverride, autoMfaContext);
});

ipcMain.handle('get-scripts', async () => {
  const scriptsDir = getScriptsDir();
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
  const autoMfaOverride = request?.autoMfa || {};
  const autoMfaContext = {
    targetProfileName: String(scriptArgs?.target_profile_name || '').trim(),
    targetAccountNumber: String(scriptArgs?.target_account_num || '').trim(),
  };

  if (typeof scriptName !== 'string' || scriptName.includes('..') || scriptName.includes('/') || scriptName.includes('\\')) {
    throw new Error('Invalid script name');
  }

  const scriptsDir = getScriptsDir();
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
      autoMfaOverride,
      autoMfaContext,
      autoMfaAttempted: false,
    });
    event.sender.send('script-state', { running: true, scriptName });

    if (prompts.length > 0) {
      emitPromptLine(event.sender, prompts[0]);

      if (prompts[0].toLowerCase().includes('mfa')) {
        void tryAutoMfa(runningProcesses.get(event.sender.id), event.sender);
      }
    }

    childProcess.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      event.sender.send('script-output', text);

      if (text.toLowerCase().includes('enter mfa code')) {
        void tryAutoMfa(runningProcesses.get(event.sender.id), event.sender);
      }
    });

    childProcess.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      event.sender.send('script-output', `stderr: ${text}`);

      if (text.toLowerCase().includes('enter mfa code')) {
        void tryAutoMfa(runningProcesses.get(event.sender.id), event.sender);
      }
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