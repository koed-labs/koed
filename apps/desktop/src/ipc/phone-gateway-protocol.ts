import { z } from "zod";

export const phoneGatewayChannel = "koed:phone-gateway:command";
export const phoneGatewayChangedChannel = "koed:phone-gateway:changed";

export const phoneGatewayRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("status") }).strict(),
  z.object({ operation: z.literal("enable"), enabled: z.boolean() }).strict(),
  z.object({ operation: z.literal("pair") }).strict(),
  z.object({ operation: z.literal("cancelPairing") }).strict(),
  z.object({ operation: z.literal("revoke"), phoneId: z.uuid() }).strict(),
  z.object({ operation: z.literal("restart") }).strict()
]);

export const phoneGatewayStatusSchema = z
  .object({
    enabled: z.boolean(),
    listening: z.array(z.string().max(64)).max(16),
    error: z.string().max(512).nullable(),
    phones: z
      .array(
        z
          .object({
            id: z.uuid(),
            name: z.string().max(80),
            platform: z.string().max(16),
            pairedAt: z.string(),
            lastSeenAt: z.string().nullable(),
            push: z.boolean(),
            connected: z.boolean()
          })
          .strict()
      )
      .max(8),
    pairing: z
      .object({
        link: z.string().max(2_048),
        code: z.string().regex(/^\d{6}$/u),
        addresses: z.array(z.string().max(64)).max(16),
        expiresAt: z.string()
      })
      .strict()
      .nullable()
  })
  .strict();

export type PhoneGatewayRequest = z.infer<typeof phoneGatewayRequestSchema>;
export type PhoneGatewayStatusView = z.infer<typeof phoneGatewayStatusSchema>;

export interface PhoneGatewayDesktopApi {
  command(request: PhoneGatewayRequest): Promise<PhoneGatewayStatusView>;
  onChange(listener: (status: PhoneGatewayStatusView) => void): () => void;
}
