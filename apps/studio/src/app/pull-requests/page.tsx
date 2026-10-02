"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PullRequestsView } from "@/components/studio/PullRequestsView";

function PullRequestsRoute() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const demo = searchParams.get("demo") === "1";
  const requestedReview = searchParams.get("review");
  const initialReviewId =
    !demo &&
    requestedReview &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      requestedReview
    )
      ? requestedReview
      : undefined;
  const suffix = demo ? "?demo=1" : "";
  return (
    <PullRequestsView
      key={demo ? "demo" : `live:${initialReviewId ?? "inbox"}`}
      initialReviewId={initialReviewId}
      mode={demo ? "demo" : "live"}
      onHome={() => router.push(`/${suffix}`)}
      onNewChat={() => router.push(demo ? "/?demo=1&chat=1" : "/?chat=1")}
      onPlugins={() => router.push(`/plugins${suffix}`)}
      onUseRealGitHub={() => router.push("/plugins")}
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
