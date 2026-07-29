import { Check, ChevronRight } from "lucide-react";
import { useState } from "react";

const lessons = [
  {
    title: "Personal and Team are separate",
    body: "Personal Memory is visible only to you. Team Chat and Team-shared Memory use a remote Team identity and do not automatically become Personal Memory."
  },
  {
    title: "Capture is explicit and pausable",
    body: "The Supported Capture Hook records eligible AI Client Conversations according to your Capture Policy. Capture Pause temporarily blocks automatic capture; it does not delete existing Memory."
  },
  {
    title: "Your AI Client performs synthesis",
    body: "Koed recalls an Evidence Bundle. The connected AI Client turns that evidence into a Memory Answer; Koed's backend does not generate the answer."
  },
  {
    title: "Review exactly what is shared",
    body: "Share preview shows the exact outgoing representation. A snapshot shares one revision; continuous sharing can publish later eligible revisions."
  },
  {
    title: "Revocation and retention differ",
    body: "Revoking a Share Grant stops current Team access. Team Retention Policy may separately retain an authorized Team-side record; revocation is not a promise of deletion."
  }
] as const;

export type TrustBoundaryGuideProps = {
  onComplete: () => Promise<void> | void;
};

export function TrustBoundaryGuide({ onComplete }: TrustBoundaryGuideProps) {
  const [index, setIndex] = useState(0);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const lesson = lessons[index]!;
  const last = index === lessons.length - 1;

  return (
    <section
      aria-labelledby="trust-boundary-title"
      className="koed-trust-guide"
    >
      <header>
        <h1 id="trust-boundary-title">How Koed handles your Memory</h1>
        <p>
          {index + 1} of {lessons.length}
        </p>
      </header>
      <div className="koed-trust-lesson">
        <h2>{lesson.title}</h2>
        <p>{lesson.body}</p>
        {completionError ? (
          <p className="koed-setup-error" role="alert">
            {completionError}
          </p>
        ) : null}
      </div>
      <footer>
        <button
          className="koed-button koed-button-secondary"
          disabled={index === 0}
          onClick={() => setIndex((current) => Math.max(0, current - 1))}
          type="button"
        >
          Back
        </button>
        <button
          className="koed-button"
          disabled={finishing}
          onClick={() => {
            if (!last) {
              setIndex((current) => current + 1);
              return;
            }
            setCompletionError(null);
            setFinishing(true);
            void Promise.resolve(onComplete()).catch((cause: unknown) => {
              setCompletionError(
                cause instanceof Error
                  ? cause.message
                  : "Onboarding completion could not be saved."
              );
              setFinishing(false);
            });
          }}
          type="button"
        >
          {last ? (
            <>
              <Check aria-hidden="true" /> Finish
            </>
          ) : (
            <>
              Next <ChevronRight aria-hidden="true" />
            </>
          )}
        </button>
      </footer>
    </section>
  );
}
