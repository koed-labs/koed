"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PullRequestsView } from "@/components/studio/PullRequestsView";
import { prChatHttpAdapter } from "@/lib/studio-pr-chat-client";

function PullRequestsRoute() {
  const router = useRouter();
  const demo = useSearchParams().get("demo") === "1";
  const suffix = demo ? "?demo=1" : "";
  return (
    <PullRequestsView
      key={demo ? "demo" : "live"}
      mode={demo ? "demo" : "live"}
      onHome={() => router.push(`/${suffix}`)}
      onNewChat={() => router.push(demo ? "/?demo=1&chat=1" : "/?chat=1")}
      onPlugins={() => router.push(`/plugins${suffix}`)}
      onUseRealGitHub={() => router.push("/plugins")}
      chatAdapter={demo ? null : prChatHttpAdapter}
    />
  );
}

export default function PullRequestsPage() {
  return (
    <Suspense fallback={null}>
      <PullRequestsRoute />
    </Suspense>
  );
}
