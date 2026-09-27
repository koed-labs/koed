"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MemoryInboxView } from "@/components/studio/MemoryInboxView";
import { WorkspaceProvider } from "@/components/WorkspaceProvider";

function MemoryInboxRoute() {
  const router = useRouter();
  const demo = useSearchParams().get("demo") === "1";
  const suffix = demo ? "?demo=1" : "";

  return (
    <MemoryInboxView
      mode={demo ? "demo" : "live"}
      onHome={() => router.push(`/${suffix}`)}
      onNewChat={() => router.push(demo ? "/?demo=1&chat=1" : "/?chat=1")}
      onPullRequests={() => router.push(`/pull-requests${suffix}`)}
      onPlugins={() => router.push(`/plugins${suffix}`)}
      onPreview={() => router.push("/memory-inbox?demo=1")}
    />
  );
}

export default function MemoryInboxPage() {
  return (
    <Suspense fallback={null}>
      <WorkspaceProvider>
        <MemoryInboxRoute />
      </WorkspaceProvider>
    </Suspense>
  );
}
