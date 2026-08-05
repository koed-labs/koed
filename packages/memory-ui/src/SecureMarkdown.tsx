import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

export const DEFAULT_MARKDOWN_MAX_BYTES = 256 * 1024;
export const DEFAULT_MARKDOWN_MAX_URL_LENGTH = 2_048;

const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export type MarkdownPlatformAdapters = {
  openExternal: (url: string) => Promise<void> | void;
  writeClipboard: (text: string) => Promise<void> | void;
};

export type SecureMarkdownAction = "copy" | "open-external";

export type SecureMarkdownProps = {
  adapters: MarkdownPlatformAdapters;
  className?: string;
  maxInputBytes?: number;
  maxUrlLength?: number;
  onActionError?: (error: unknown, action: SecureMarkdownAction) => void;
  onOversizedInput?: (details: {
    actualBytes: number;
    maxBytes: number;
  }) => void;
  oversizedFallback?: ReactNode;
  source: string;
};

export type MarkdownInputValidation =
  | {
      byteLength: number;
      ok: true;
    }
  | {
      byteLength: number;
      maxBytes: number;
      ok: false;
      reason: "oversized";
    };

function hasUnsafeUrlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).byteLength;
  }
  return new Blob([value]).size;
}

export function validateMarkdownInput(
  source: string,
  maxBytes = DEFAULT_MARKDOWN_MAX_BYTES
): MarkdownInputValidation {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  const byteLength = utf8ByteLength(source);
  if (byteLength > maxBytes) {
    return { byteLength, maxBytes, ok: false, reason: "oversized" };
  }
  return { byteLength, ok: true };
}

export function sanitizeMarkdownUrl(
  value: string | null | undefined,
  maxLength = DEFAULT_MARKDOWN_MAX_URL_LENGTH
): string | null {
  if (!value || value.length > maxLength || hasUnsafeUrlCharacters(value)) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed !== value || trimmed.length === 0) return null;

  try {
    const url = new URL(trimmed);
    if (!ALLOWED_URL_PROTOCOLS.has(url.protocol.toLowerCase())) return null;
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.username.length > 0 || url.password.length > 0)
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export function markdownNodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => markdownNodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return markdownNodeToPlainText(node.props.children);
  }
  return "";
}

export function extractMarkdownCodeBlock(children: ReactNode): string | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) return null;
  const child = childNodes[0];
  if (!isValidElement<{ children?: ReactNode }>(child)) return null;
  return markdownNodeToPlainText(child.props.children).replace(/\n$/u, "");
}

function runAdapterAction(
  action: SecureMarkdownAction,
  callback: () => Promise<void> | void,
  onError?: (error: unknown, action: SecureMarkdownAction) => void
): Promise<boolean> {
  return Promise.resolve()
    .then(callback)
    .then(() => true)
    .catch((error: unknown) => {
      onError?.(error, action);
      return false;
    });
}

function CopyCodeButton({
  adapters,
  code,
  onActionError
}: {
  adapters: MarkdownPlatformAdapters;
  code: string;
  onActionError?: SecureMarkdownProps["onActionError"];
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) {
        clearTimeout(resetTimerRef.current);
      }
    },
    []
  );

  return (
    <button
      aria-label={
        state === "copied"
          ? "Code copied"
          : state === "failed"
            ? "Copy code failed. Try again"
            : "Copy code"
      }
      className="memory-markdown-copy-code"
      data-state={state}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setState("idle");
        void runAdapterAction(
          "copy",
          () => adapters.writeClipboard(code),
          onActionError
        ).then((succeeded) => {
          setState(succeeded ? "copied" : "failed");
          if (resetTimerRef.current !== null) {
            clearTimeout(resetTimerRef.current);
          }
          resetTimerRef.current = setTimeout(
            () => {
              setState("idle");
              resetTimerRef.current = null;
            },
            succeeded ? 1_200 : 2_400
          );
        });
      }}
      type="button"
    >
      <span aria-live="polite">
        {state === "copied"
          ? "Copied"
          : state === "failed"
            ? "Copy failed"
            : "Copy"}
      </span>
    </button>
  );
}

function DisabledImage({ alt }: { alt?: string }) {
  if (!alt) return null;
  return (
    <span className="memory-markdown-image-alt" role="img" aria-label={alt}>
      {alt}
    </span>
  );
}

export function SecureMarkdown({
  adapters,
  className,
  maxInputBytes = DEFAULT_MARKDOWN_MAX_BYTES,
  maxUrlLength = DEFAULT_MARKDOWN_MAX_URL_LENGTH,
  onActionError,
  onOversizedInput,
  oversizedFallback,
  source
}: SecureMarkdownProps) {
  const validation = useMemo(
    () => validateMarkdownInput(source, maxInputBytes),
    [maxInputBytes, source]
  );
  const lastOversizedReportRef = useRef<string | null>(null);

  useEffect(() => {
    if (validation.ok) {
      lastOversizedReportRef.current = null;
      return;
    }
    const reportKey = `${validation.byteLength}:${validation.maxBytes}`;
    if (lastOversizedReportRef.current === reportKey) return;
    lastOversizedReportRef.current = reportKey;
    onOversizedInput?.({
      actualBytes: validation.byteLength,
      maxBytes: validation.maxBytes
    });
  }, [onOversizedInput, validation]);

  const components = useMemo<Components>(
    () => ({
      a({ children, href }) {
        const safeUrl = sanitizeMarkdownUrl(href, maxUrlLength);
        if (!safeUrl) return <span>{children}</span>;

        const open = () => {
          void runAdapterAction(
            "open-external",
            () => adapters.openExternal(safeUrl),
            onActionError
          );
        };

        return (
          <button
            aria-label={`Open external link: ${markdownNodeToPlainText(children)}`}
            className="memory-markdown-external-link"
            onClick={open}
            role="link"
            type="button"
          >
            {children}
          </button>
        );
      },
      img({ alt }) {
        return <DisabledImage alt={alt} />;
      },
      pre({ children, ...props }) {
        const code = extractMarkdownCodeBlock(children);
        return (
          <div className="memory-markdown-code-block">
            {code === null ? null : (
              <CopyCodeButton
                adapters={adapters}
                code={code}
                onActionError={onActionError}
              />
            )}
            <pre {...props}>{children}</pre>
          </div>
        );
      },
      table({ children, ...props }) {
        return (
          <div className="memory-markdown-table-scroll" tabIndex={0}>
            <table {...props}>{children}</table>
          </div>
        );
      }
    }),
    [adapters, maxUrlLength, onActionError]
  );

  if (!validation.ok) {
    return (
      <div
        className={["memory-markdown", className].filter(Boolean).join(" ")}
        role="alert"
      >
        {oversizedFallback ?? "This message is too large to display safely."}
      </div>
    );
  }

  return (
    <div className={["memory-markdown", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        components={components}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => sanitizeMarkdownUrl(url, maxUrlLength) ?? ""}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
