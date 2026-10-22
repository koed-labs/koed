const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hq901MergeNative", (request) =>
  ipcRenderer.invoke("hq901:merge-native", request)
);
