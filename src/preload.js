const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listScripts: () => ipcRenderer.invoke('get-scripts'),
  runScript: (scriptName) => ipcRenderer.invoke('run-script', scriptName),
  sendScriptInput: (input) => ipcRenderer.send('send-script-input', input),
  stopScript: () => ipcRenderer.send('stop-script'),
  onScriptOutput: (callback) => {
    ipcRenderer.removeAllListeners('script-output');
    ipcRenderer.on('script-output', (_, chunk) => callback(chunk));
  },
  onScriptState: (callback) => {
    ipcRenderer.removeAllListeners('script-state');
    ipcRenderer.on('script-state', (_, state) => callback(state));
  },
});