export declare const managedChiefOfStaffPromptOptions: (
  name: string | null | undefined
) =>
  | {
      appendSystemPromptOverride: (base: string[]) => string[];
    }
  | {
      appendSystemPromptOverride?: never;
    };
