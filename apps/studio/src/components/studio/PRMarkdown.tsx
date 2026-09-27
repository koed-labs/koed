"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const MAX_URL_LENGTH = 2_048;

function hasUnsafeUrlCharacters(value: string) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

export function sanitizePrMarkdownUrl(value: string | null | undefined) {
  if (!value || value.length > MAX_URL_LENGTH || hasUnsafeUrlCharacters(value)) {
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

function DisabledImage({ alt }: { alt?: string }) {
  if (!alt) return null;
  return (
    <span className="text-subtle" role="img" aria-label={alt}>
      {alt}
    </span>
  );
}

const components: Components = {
  a({ children, href }) {
    const safeUrl = sanitizePrMarkdownUrl(href);
    if (!safeUrl) return <span>{children}</span>;
    return (
      <a
        href={safeUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent underline decoration-accent/50 underline-offset-2 hover:decoration-accent"
      >
        {children}
      </a>
    );
  },
  img({ alt }) {
    return <DisabledImage alt={alt} />;
  },
  h1({ children }) {
    return (
      <h3 className="mt-5 text-lg font-semibold text-foreground first:mt-0">
        {children}
      </h3>
    );
  },
  h2({ children }) {
    return (
      <h4 className="mt-5 text-base font-semibold text-foreground first:mt-0">
        {children}
      </h4>
    );
  },
  h3({ children }) {
    return (
      <h5 className="mt-4 text-[15px] font-semibold text-foreground first:mt-0">
        {children}
      </h5>
    );
  },
  h4({ children }) {
    return (
      <h6 className="mt-4 text-[15px] font-semibold text-foreground first:mt-0">
        {children}
      </h6>
    );
  },
  h5({ children }) {
    return (
      <h6 className="mt-4 text-[15px] font-semibold text-foreground first:mt-0">
        {children}
      </h6>
    );
  },
  h6({ children }) {
    return (
      <h6 className="mt-4 text-[15px] font-semibold text-foreground first:mt-0">
        {children}
      </h6>
    );
  },
  p({ children }) {
    return (
      <p className="mt-3 break-words leading-relaxed first:mt-0 [overflow-wrap:anywhere]">
        {children}
      </p>
    );
  },
  ul({ children }) {
    return (
      <ul className="mt-3 list-disc space-y-1 pl-5 first:mt-0">{children}</ul>
    );
  },
  ol({ children }) {
    return (
      <ol className="mt-3 list-decimal space-y-1 pl-5 first:mt-0">
        {children}
      </ol>
    );
  },
  li({ children }) {
    return <li className="break-words [overflow-wrap:anywhere]">{children}</li>;
  },
  blockquote({ children }) {
    return (
      <blockquote className="mt-3 border-l-2 border-border-strong pl-4 text-muted">
        {children}
      </blockquote>
    );
  },
  pre({ children }) {
    return (
      <pre className="mt-3 max-w-full overflow-x-auto rounded-lg border border-border bg-background/70 p-3 text-xs leading-relaxed text-foreground-secondary">
        {children}
      </pre>
    );
  },
  code({ children, className }) {
    const block = Boolean(className);
    return block ? (
      <code className="font-mono">{children}</code>
    ) : (
      <code className="rounded bg-surface-hover px-1 py-0.5 font-mono text-[0.9em] text-foreground-secondary">
        {children}
      </code>
    );
  },
  table({ children }) {
    return (
      <div className="mt-3 max-w-full overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[420px] border-collapse text-left text-xs">
          {children}
        </table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="border-b border-border bg-surface px-3 py-2 font-medium text-foreground-secondary">
        {children}
      </th>
    );
  },
  td({ children }) {
    return (
      <td className="border-b border-border/70 px-3 py-2 align-top text-muted last:border-b-0">
        {children}
      </td>
    );
  },
  input({ checked, type }) {
    if (type !== "checkbox") return null;
    return (
      <input
        type="checkbox"
        checked={checked}
        disabled
        readOnly
        className="mr-2 align-[-2px] accent-accent"
      />
    );
  }
};

export function PRMarkdown({ source }: { source: string }) {
  return (
    <div className="min-w-0 break-words text-sm text-muted [overflow-wrap:anywhere]">
      <ReactMarkdown
        components={components}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => sanitizePrMarkdownUrl(url) ?? ""}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
