import {
  phoneGatewayChangedChannel,
  phoneGatewayChannel,
  phoneGatewayRequestSchema,
  phoneGatewayStatusSchema,
  type PhoneGatewayDesktopApi,
  type PhoneGatewayStatusView
} from "./phone-gateway-protocol.js";

type Events = {
  on: (
    channel: string,
    listener: (event: unknown, value: unknown) => void
  ) => void;
  removeListener: (
    channel: string,
    listener: (event: unknown, value: unknown) => void
  ) => void;
};

export const createPhoneGatewayPreloadApi = (
  invoke: (channel: string, value: unknown) => Promise<unknown>,
  events: Events
): PhoneGatewayDesktopApi =>
  Object.freeze({
    command: async (value: unknown) =>
      phoneGatewayStatusSchema.parse(
        await invoke(
          phoneGatewayChannel,
          phoneGatewayRequestSchema.parse(value)
        )
      ),
    onChange: (listener: (status: PhoneGatewayStatusView) => void) => {
      const handler = (_event: unknown, value: unknown) => {
        const parsed = phoneGatewayStatusSchema.safeParse(value);
        if (parsed.success) listener(parsed.data);
      };
      events.on(phoneGatewayChangedChannel, handler);
      return () => events.removeListener(phoneGatewayChangedChannel, handler);
    }
  });
