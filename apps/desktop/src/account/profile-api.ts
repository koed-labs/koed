import {
  accountDetailsSchema,
  emailUpdatesPreferenceSchema,
  type AccountDetails
} from "@koed-labs/shared/account";

export function createAccountProfileApi(origin: string) {
  const request = async (path: string, accessToken: string, input?: object) => {
    const response = await fetch(new URL(path, origin), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(input ? { "Content-Type": "application/json" } : {})
      },
      ...(input ? { method: "PUT", body: JSON.stringify(input) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error("Account profile unavailable");
    return response.json();
  };
  return {
    async getProfile(accessToken: string, userId: string) {
      const profile = accountDetailsSchema.parse(
        await request("/v1/account/profile", accessToken)
      );
      if (profile.userId !== userId)
        throw new Error("Unexpected account profile");
      return profile;
    },
    async setEmailUpdates(
      accessToken: string,
      subscribed: boolean,
      current: AccountDetails["emailUpdates"]
    ) {
      const updated = emailUpdatesPreferenceSchema.parse(
        await request("/v1/account/email-updates", accessToken, {
          subscribed,
          expectedRevision: current.revision,
          ...(subscribed
            ? { email: current.email, noticeVersion: current.noticeVersion }
            : {})
        })
      );
      if (
        updated.subscribed !== subscribed ||
        updated.revision < current.revision
      ) {
        throw new Error("Unexpected email updates preference");
      }
      return updated;
    }
  };
}
