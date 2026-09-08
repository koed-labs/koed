// Isolate the controls fixture from Node-only imports in the full development fixture.
if (
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
