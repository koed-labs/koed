const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hq901DocItems", () =>
  ipcRenderer.invoke("hq901:doc-items")
);
