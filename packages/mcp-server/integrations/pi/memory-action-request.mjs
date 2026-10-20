export const memoryActionRequest = (name) => ({
  content: [
    {
      type: "text",
      text: `Koed ${name} request v1: {"status":"requested"}`
    }
  ],
  details: { status: "requested" }
});
