"use client";

import { useRouter } from "next/navigation";
import { AgentsView } from "@/components/studio/AgentsView";

export default function AgentsPage() {
  const router = useRouter();
  return (
    <AgentsView
      onHome={() => router.push("/")}
      onNewChat={() => router.push("/?chat=1")}
      onGiveAJob={(agent) =>
        router.push(`/?chat=1&agent=${encodeURIComponent(agent.id)}`)
      }
      onOpenConversation={(conversationId) =>
        router.push(`/?chat=1&execution=${encodeURIComponent(conversationId)}`)
      }
      onPullRequests={() => router.push("/pull-requests")}
      onPlugins={() => router.push("/plugins")}
    />
  );
}
