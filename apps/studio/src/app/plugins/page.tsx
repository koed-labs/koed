"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PluginsView } from "@/components/studio/PluginsView";

function PluginsRoute() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const demo = searchParams.get("demo") === "1";
  const homeHref = demo ? "/?demo=1" : "/";

  return (
    <PluginsView
      key={demo ? "demo" : "live"}
      mode={demo ? "demo" : "live"}
      onHome={() => router.push(homeHref)}
      onNewChat={() => router.push(demo ? "/?demo=1&chat=1" : "/?chat=1")}
      onPullRequests={() =>
        router.push(demo ? "/pull-requests?demo=1" : "/pull-requests")
      }
      onUseRealGitHub={() => router.push("/plugins")}
      onPlugins={() => router.refresh()}
    />
  );
}

export default function PluginsPage() {
  return (
    <Suspense fallback={null}>
      <PluginsRoute />
    </Suspense>
  );
}
