import { useEffect, useState, type ReactNode } from "react";

/**
 * What the conversation shows while a reply is on its way. The first words of
 * a reply can take a few seconds, so the line moves through short steps to
 * show progress instead of one static "working" message. A step the AI
 * Client reports (for example "Checking memory") replaces them, and the line
 * disappears as soon as the reply itself starts arriving.
 */
export const hqWorkingSteps = (name: string): string[] => [
  `${name} is reading your message`,
  "Thinking it through",
  "Working out the best answer",
  "Putting the reply together",
  "Almost there"
];

const stepMs = 2_600;
const longWaitMs = 25_000;

export function HqWorkingLine({
  name,
  activity,
  avatar
}: {
  name: string;
  activity: string | null;
  avatar?: ReactNode;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(
      () => setElapsed(Date.now() - started),
      500
    );
    return () => window.clearInterval(timer);
  }, []);
  const steps = hqWorkingSteps(name);
  const text = activity
    ? activity
    : elapsed >= longWaitMs
      ? "Still working on it. Longer questions take a little more time"
      : steps[Math.min(Math.floor(elapsed / stepMs), steps.length - 1)]!;
  return (
    <p
      className={`hq-conversation__working${avatar ? " hq-conversation__working--with-avatar" : ""}`}
      role="status"
    >
      {avatar ? (
        <span className="hq-conversation__avatar" aria-hidden="true">
          {avatar}
        </span>
      ) : null}
      <span className="hq-conversation__working-text" key={text}>
        {text}…
      </span>
    </p>
  );
}
