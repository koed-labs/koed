import { createContext, type ComponentType, type ComponentProps } from "react";
import type { NativeConversationSurface } from "../NativeConversationSurface.js";
import type { ConversationInput } from "./views/personal/ConversationInput.js";

// Presentation is replaceable; the existing managed execution controller owns
// streaming, approval authority, recovery, drafts and command delivery.
export const ConversationPresentationContext = createContext<{
  Input?: ComponentType<ComponentProps<typeof ConversationInput>>;
  Surface?: ComponentType<ComponentProps<typeof NativeConversationSurface>>;
  compact?: boolean;
}>({});
