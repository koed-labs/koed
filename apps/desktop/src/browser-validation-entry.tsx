// Isolate the controls fixture from Node-only imports in the full development fixture.
if (new URLSearchParams(location.search).get("view") === "projects-default") {
  try {
    const [{ createRoot }, { ProjectsDefaultValidation }] = await Promise.all([
      import("react-dom/client"),
      import("./projects-default-validation.js"),
      import("./renderer/index.css")
    ]);
    createRoot(document.querySelector("#root")!).render(
      <ProjectsDefaultValidation />
    );
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    throw error;
  }
} else if (
  new URLSearchParams(location.search).get("view") === "project-transfer"
) {
  const [{ createRoot }, { ProjectTransferValidation }] = await Promise.all([
    import("react-dom/client"),
    import("./project-transfer-validation.js"),
    import("./renderer/index.css")
  ]);
  createRoot(document.querySelector("#root")!).render(
    <ProjectTransferValidation />
  );
} else if (
  import.meta.env.DEV &&
  new URLSearchParams(location.search).get("view") === "conversation-settings"
) {
  const [{ createRoot }, { ConversationSettingsValidation }] =
    await Promise.all([
      import("react-dom/client"),
      import("./conversation-settings-validation.js"),
      import("./renderer/index.css")
    ]);
  createRoot(document.querySelector("#root")!).render(
    <ConversationSettingsValidation />
  );
} else {
  await import("./browser-validation.js");
}

export {};
