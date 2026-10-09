'use strict';
const {contextBridge, ipcRenderer} = require('electron');
const commands = new Set(['snapshot','addLocal','connect','answerAuth','cancelAuth','addDisk','updateDisk','removeDisk','mount','unmount','deleteConnection','testConnection','listFolders','setFolder','pickFolder','openDisk','openData','settings','installDriver','quit']);
contextBridge.exposeInMainWorld('island', Object.freeze({
  invoke: async (method, ...args) => {
    if (!commands.has(method)) throw new Error('不支持此操作');
    const result = await ipcRenderer.invoke('island', method, ...args);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  onChange: callback => {const listener = () => callback(); ipcRenderer.on('changed', listener); return () => ipcRenderer.removeListener('changed', listener);}
}));
