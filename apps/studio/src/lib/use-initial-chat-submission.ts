"use client";
import { useEffect, useRef } from "react";
import type { ChatComposerSelection } from "@/components/ChatComposer";
export type InitialChatSubmission = Readonly<{
  id: string;
  text: string;
  selection: ChatComposerSelection;
}>;
/** Home Send is an explicit submission. Other navigation only opens a draft. */
export function useInitialChatSubmission({
  submission,
  ready,
  send,
  claim
}: {
  submission?: InitialChatSubmission;
  ready: boolean;
  claim?: (id: string) => boolean;
  send: (text: string, selection: ChatComposerSelection) => Promise<unknown>;
}) {
  const attempted = useRef<string | null>(null);
  useEffect(() => {
    if (!submission || !ready || attempted.current === submission.id) return;
    // Mark before invoking send so rerenders and Strict Mode cannot duplicate it.
    // The send path persists its idempotency identity before contacting the runner.
    attempted.current = submission.id;
    if (claim && !claim(submission.id)) return;
    void send(submission.text, submission.selection).catch(() => {
      // The managed send path shows the error and retains the draft for explicit retry.
    });
  }, [submission, ready, send, claim]);
}
