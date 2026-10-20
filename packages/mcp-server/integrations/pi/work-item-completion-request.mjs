export const workItemCompletionRequest = () => ({
  content: [
    {
      type: "text",
      text: "Work Item completion requested. Koed will verify the running execution."
    }
  ],
  details: { status: "requested" }
});
