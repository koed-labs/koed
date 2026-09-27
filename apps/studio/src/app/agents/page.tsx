"use client";

import { useRouter } from "next/navigation";
import { AgentsView } from "@/components/studio/AgentsView";

export default function AgentsPage() {
  const router = useRouter();
  return (
    <AgentsView
      onHome={() => router.push("/")}
      onNewChat={() => router.push("/?chat=1")}
      onPullRequests={() => router.push("/pull-requests")}
      onPlugins={() => router.push("/plugins")}
    />
  );
}
