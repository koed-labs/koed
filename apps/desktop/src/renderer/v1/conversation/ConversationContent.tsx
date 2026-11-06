import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, Copy, FileCode2 } from "lucide-react";
import {
  Button,
  Tooltip,
  TooltipTrigger,
  TooltipPopup,
  CodeBlock,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockActions,
  CodeBlockContent
} from "@koed/ui";
import { SecureMarkdown, type MarkdownPlatformAdapters } from "@koed/memory-ui";
import { AiClientLogo } from "../../views/personal/AiClientLogo.js";
import { conversationTime, type ConversationClient } from "./presentation.js";

export function ConversationIconButton({
  label,
  children,
  onClick
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            className="v1-conversation-icon-button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

export function ConversationCopyButton({
  text,
  label,
  adapters,
  onError
}: {
  text: string;
  label: string;
  adapters: MarkdownPlatformAdapters;
  onError: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => setCopied(false), [text]);
  return (
    <>
      <ConversationIconButton
        label={copied ? "Copied" : label}
        onClick={() => {
          void Promise.resolve()
            .then(() => adapters.writeClipboard(text))
            .then(() => {
              setCopied(true);
              onError("");
            })
            .catch(() =>
              onError("The content could not be copied. Please try again.")
            );
        }}
      >
        {copied ? <Check /> : <Copy />}
      </ConversationIconButton>
      <span className="sr-only" role="status">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </>
  );
}

export function ConversationCode({
  text,
  title,
  adapters,
  onError
}: {
  text: string;
  title: string;
  adapters: MarkdownPlatformAdapters;
  onError: (message: string) => void;
}) {
  return (
    <CodeBlock className="v1-inspector-code">
      <CodeBlockHeader>
        <CodeBlockTitle>
          <FileCode2 /> {title}
        </CodeBlockTitle>
        <CodeBlockActions>
          <ConversationCopyButton
            text={text}
            label="Copy code"
            adapters={adapters}
            onError={onError}
          />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent>{text}</CodeBlockContent>
    </CodeBlock>
  );
}

export function ConversationMarkdown({
  text,
  adapters,
  onError
}: {
  text: string;
  adapters: MarkdownPlatformAdapters;
  onError: (message: string) => void;
}) {
  const renderCodeBlock = useCallback(
    ({ code, language }: { code: string; language: string | null }) => (
      <ConversationCode
        text={code}
        title={language || "Code"}
        adapters={adapters}
        onError={onError}
      />
    ),
    [adapters, onError]
  );
  return (
    <SecureMarkdown
      source={text}
      adapters={adapters}
      renderCodeBlock={renderCodeBlock}
      onActionError={(_, action) =>
        onError(
          action === "copy"
            ? "The content could not be copied."
            : "The link could not be opened."
        )
      }
    />
  );
}

export function ConversationClientMark({
  client
}: {
  client: ConversationClient;
}) {
  return client.id ? (
    <span className={`v1-conversation-client ${client.id}`} aria-hidden="true">
      <AiClientLogo id={client.id} />
    </span>
  ) : null;
}

export function ConversationTime({ value }: { value: string }) {
  return (
    <time
      className="v1-conversation-time"
      dateTime={value}
      title={conversationTime(value, true)}
    >
      {conversationTime(value)}
    </time>
  );
}
