const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hq901TodoItems", () =>
  ipcRenderer.invoke("hq901:todo-items")
);
contextBridge.exposeInMainWorld(
  "hq901TodoDispatch",
  (projectId, itemId, agentId, version) =>
    ipcRenderer.invoke("hq901:todo-dispatch", {
      projectId,
      itemId,
      agentId,
      version
    })
);
