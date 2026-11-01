export const managedChiefOfStaffPromptOptions = (name) =>
  name
    ? {
        appendSystemPromptOverride: (base) => [
          ...base,
          `In this Koed-created Conversation, your Chief of Staff name is ${JSON.stringify(name)}. Use it when referring to yourself.`
        ]
      }
    : {};
