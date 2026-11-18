import {
  accountCommandChannel,
  accountCommandSchema,
  accountStateChannel,
  accountStateSchema,
  type AccountDesktopApi
} from "@koed-labs/shared/account";
export function createAccountPreloadApi(
  invoke: (channel: string, value: unknown) => Promise<unknown>,
  events: {
    on(
      channel: string,
      listener: (_event: unknown, value: unknown) => void
    ): unknown;
    removeListener(
      channel: string,
      listener: (_event: unknown, value: unknown) => void
    ): unknown;
  }
): AccountDesktopApi {
  const command = async (value: unknown) =>
    accountStateSchema.parse(
      await invoke(accountCommandChannel, accountCommandSchema.parse(value))
    );
  return Object.freeze({
    getState: () => command({ operation: "getState" }),
    signIn: (input: { screen: "sign-in" | "sign-up" }) =>
      command({ operation: "signIn", screen: input.screen }),
    cancelSignIn: () => command({ operation: "cancelSignIn" }),
    refreshProfile: () => command({ operation: "refreshProfile" }),
    signOut: () => command({ operation: "signOut" }),
    onStateChanged(
      listener: Parameters<AccountDesktopApi["onStateChanged"]>[0]
    ) {
      const receive = (_event: unknown, value: unknown) => {
        const result = accountStateSchema.safeParse(value);
        if (result.success) listener(result.data);
      };
      events.on(accountStateChannel, receive);
      return () => {
        events.removeListener(accountStateChannel, receive);
      };
    }
  });
}
