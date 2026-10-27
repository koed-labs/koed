/**
 * Push notifications to paired phones through Expo's free push service.
 *
 * Only what needs the person (an approval, a question, a missed run) and a
 * reply to what they said is pushed, and only to phones that aren't connected
 * right now. A push carries a title, one line and a route inside the app:
 * never a command, file content or memory.
 */

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export type PhonePush = {
  to: string;
  title: string;
  body: string;
  route: string;
};

export type PushSender = (messages: readonly PhonePush[]) => Promise<void>;

export const createExpoPushSender =
  (fetchImpl: typeof fetch = globalThis.fetch): PushSender =>
  async (messages) => {
    if (messages.length === 0) return;
    const response = await fetchImpl(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify(
        messages.slice(0, 100).map((message) => ({
          to: message.to,
          title: message.title.slice(0, 120),
          body: message.body.slice(0, 240),
          sound: "default",
          priority: "high",
          data: { route: message.route }
        }))
      ),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok)
      throw new Error(`Push service answered ${response.status}`);
  };
