import { z } from "zod";

const accountForwarderUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.pathname === "/desktop/callback" &&
        !url.username &&
        !url.password &&
        !url.port &&
        !value.includes("?") &&
        !value.includes("#") &&
        url.href === value
      );
    } catch {
      return false;
    }
  });

export const accountProfileApiOriginSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
      return (
        (value === url.origin || value === `${url.origin}/`) &&
        (url.protocol === "https:" || (url.protocol === "http:" && loopback))
      );
    } catch {
      return false;
    }
  });

/** Only public OAuth settings may cross the build/runtime configuration boundary. */
export const publicAccountConfigSchema = z
  .object({
    enabled: z.boolean(),
    clientId: z
      .string()
      .regex(/^client_[A-Za-z0-9]+$/)
      .max(100)
      .optional(),
    environment: z.string().trim().min(1).max(100).optional(),
    loginMode: z.enum(["direct", "forwarder"]).optional(),
    forwarderUrl: accountForwarderUrlSchema.optional(),
    profileApiOrigin: accountProfileApiOriginSchema.optional()
  })
  .strict();
export type PublicAccountConfig = z.infer<typeof publicAccountConfigSchema>;
export interface AccountConfig {
  clientId: string;
  environment: string;
  loginMode: "direct" | "forwarder";
  redirectUri: string;
  callbackUri: string;
  profileApiOrigin?: string;
}
export function resolveAccountConfig(
  environment: Readonly<Record<string, string | undefined>>
): AccountConfig | null {
  if (environment.KOED_ACCOUNT_ENABLED !== "true") return null;
  const value = publicAccountConfigSchema.safeParse({
    enabled: true,
    clientId: environment.KOED_ACCOUNT_CLIENT_ID?.trim(),
    environment: environment.KOED_ACCOUNT_ENVIRONMENT?.trim(),
    loginMode: environment.KOED_ACCOUNT_LOGIN_MODE?.trim() || "direct",
    forwarderUrl:
      environment.KOED_ACCOUNT_LOGIN_MODE?.trim() === "forwarder"
        ? environment.KOED_ACCOUNT_FORWARDER_URL
        : undefined
  });
  if (!value.success || !value.data.clientId || !value.data.environment)
    return null;
  const { clientId, environment: namespace, loginMode = "direct" } = value.data;
  const callbackUri =
    namespace === "production"
      ? "ai.koed.desktop.auth://callback"
      : "ai.koed.desktop.auth.dev://callback";
  if (
    loginMode === "forwarder" &&
    namespace !== "staging" &&
    namespace !== "production"
  )
    return null;
  const redirectUri =
    loginMode === "forwarder" ? value.data.forwarderUrl : callbackUri;
  if (!redirectUri) return null;
  const profileApi = accountProfileApiOriginSchema.safeParse(
    environment.KOED_ACCOUNT_PROFILE_API_ORIGIN?.trim()
  );
  return {
    clientId,
    environment: namespace,
    loginMode,
    callbackUri,
    redirectUri,
    ...(profileApi.success
      ? { profileApiOrigin: new URL(profileApi.data).origin }
      : {})
  };
}

export const accountProfilePictureUrlSchema = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        (url.hostname === "workoscdn.com" ||
          url.hostname.endsWith(".workoscdn.com") ||
          url.hostname.endsWith(".googleusercontent.com") ||
          url.hostname === "avatars.githubusercontent.com")
      );
    } catch {
      return false;
    }
  });

export const accountProfileSchema = z
  .object({
    id: z.string().regex(/^user_[A-Za-z0-9]+$/),
    displayName: z.string().max(100).nullable(),
    email: z.string().email(),
    emailVerified: z.boolean(),
    joinedAt: z.iso.datetime({ offset: true }).optional(),
    // Older encrypted profiles omit this optional presentation field.
    profilePictureUrl: accountProfilePictureUrlSchema.nullable().optional()
  })
  .strict();
export const accountMessageCodeSchema = z.enum([
  "configuration_invalid",
  "storage_unavailable",
  "browser_unavailable",
  "operation_failed",
  "session_expired",
  "sign_out_complete",
  "sign_out_failed",
  "browser_sign_out_failed",
  "sign_in_expired",
  "sign_in_failed",
  "email_updates_unconfirmed"
]);
export type AccountMessageCode = z.infer<typeof accountMessageCodeSchema>;
export const emailUpdatesPreferenceSchema = z
  .object({
    email: z.string().email(),
    subscribed: z.boolean(),
    revision: z.number().int().nonnegative(),
    noticeVersion: z.string().min(1).max(100),
    noticeText: z.string().min(1).max(1000)
  })
  .strict();
export const accountDetailsSchema = z
  .object({
    userId: accountProfileSchema.shape.id,
    emailUpdates: emailUpdatesPreferenceSchema,
    kin: z
      .object({
        unlockMask: z.string().regex(/^0x[0-9a-f]+$/),
        catalogVersion: z.string().min(1).max(100)
      })
      .strict()
  })
  .strict();
export type AccountDetails = z.infer<typeof accountDetailsSchema>;

export const accountStateSchema = z
  .object({
    status: z.enum([
      "unavailable",
      "restoring",
      "signed_out",
      "signing_in",
      "signed_in",
      "reauthentication_required"
    ]),
    profile: accountProfileSchema.nullable(),
    details: z
      .discriminatedUnion("status", [
        z.object({ status: z.literal("loading") }).strict(),
        z.object({ status: z.literal("unavailable") }).strict(),
        z
          .object({ status: z.literal("ready"), value: accountDetailsSchema })
          .strict()
      ])
      .optional(),
    stale: z.boolean(),
    busy: z.boolean(),
    message: z.string().max(300).nullable(),
    messageCode: accountMessageCodeSchema.nullable().optional(),
    revision: z.number().int().nonnegative()
  })
  .strict();
export const accountCommandSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("getState") }).strict(),
  z
    .object({
      operation: z.literal("signIn"),
      screen: z.enum(["sign-in", "sign-up"])
    })
    .strict(),
  z.object({ operation: z.literal("cancelSignIn") }).strict(),
  z.object({ operation: z.literal("refreshProfile") }).strict(),
  z.object({ operation: z.literal("reportProfileOffline") }).strict(),
  z
    .object({
      operation: z.literal("setEmailUpdates"),
      subscribed: z.boolean(),
      stateRevision: z.number().int().nonnegative()
    })
    .strict(),
  z.object({ operation: z.literal("signOut") }).strict()
]);
export type AccountProfile = z.infer<typeof accountProfileSchema>;
export type AccountState = z.infer<typeof accountStateSchema>;
export type AccountCommand = z.infer<typeof accountCommandSchema>;
export interface AccountDesktopApi {
  getState(): Promise<AccountState>;
  signIn(input: { screen: "sign-in" | "sign-up" }): Promise<AccountState>;
  cancelSignIn(): Promise<AccountState>;
  refreshProfile(): Promise<AccountState>;
  reportProfileOffline(): Promise<AccountState>;
  setEmailUpdates(input: {
    subscribed: boolean;
    stateRevision: number;
  }): Promise<AccountState>;
  signOut(): Promise<AccountState>;
  onStateChanged(listener: (state: AccountState) => void): () => void;
}
export const accountCommandChannel = "koed:account:command";
export const accountStateChannel = "koed:account:state";
