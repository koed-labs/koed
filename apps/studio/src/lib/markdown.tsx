import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function sanitizeChatMarkdownUrl(value: string | null | undefined) {
  if (
    !value ||
    value.length > 2_048 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.trim() !== value
  )
    return null;
  try {
    const url = new URL(value);
    if (!ALLOWED_PROTOCOLS.has(url.protocol.toLowerCase())) return null;
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.username || url.password)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function DisabledImage({ alt }: { alt?: string }) {
  if (!alt) return null;
  return (
    <span role="img" aria-label={alt} className="text-subtle">
      {alt}
    </span>
  );
}

const components: Components = {
  a({ children, href }) {
    const safe = sanitizeChatMarkdownUrl(href);
    return safe ? (
      <a
        href={safe}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  img({ alt }) {
    return <DisabledImage alt={alt} />;
  },
  h1({ children }) {
    return (
      <h3 className="text-base font-semibold text-foreground">{children}</h3>
    );
  },
  h2({ children }) {
    return (
      <h4 className="text-base font-semibold text-foreground">{children}</h4>
    );
  },
  h3({ children }) {
    return (
      <h5 className="text-[15px] font-semibold text-foreground">{children}</h5>
    );
  },
  h4({ children }) {
    return (
      <h6 className="text-[15px] font-semibold text-foreground">{children}</h6>
    );
  },
  h5({ children }) {
    return (
      <h6 className="text-[15px] font-semibold text-foreground">{children}</h6>
    );
  },
  h6({ children }) {
    return (
      <h6 className="text-[15px] font-semibold text-foreground">{children}</h6>
    );
  },
  p({ children }) {
    return <p className="whitespace-pre-wrap leading-relaxed">{children}</p>;
  },
  ul({ children }) {
    return <ul className="list-disc space-y-0.5 pl-5">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="list-decimal space-y-0.5 pl-5">{children}</ol>;
  },
  li({ children }) {
    return <li>{children}</li>;
  },
  blockquote({ children }) {
    return (
      <blockquote className="border-l-2 border-border-strong pl-3 text-foreground-secondary italic">
        {children}
      </blockquote>
    );
  },
  pre({ children }) {
    return (
      <pre className="overflow-x-auto rounded-md bg-surface-hover p-2.5 text-[0.85em] leading-snug">
        {children}
      </pre>
    );
  },
  code({ children, className }) {
    const block = Boolean(className?.includes("language-"));
    return block ? (
      <code className="font-mono">{children}</code>
    ) : (
      <code className="rounded bg-surface-hover px-1 py-0.5 font-mono text-[0.85em]">
        {children}
      </code>
    );
  },
  table({ children }) {
    return (
      <div className="overflow-x-auto">
        <table className="border-collapse text-left">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="border border-border px-2 py-1 font-medium">{children}</th>
    );
  },
  td({ children }) {
    return <td className="border border-border px-2 py-1">{children}</td>;
  },
  input({ checked }) {
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

export function renderMarkdown(content: string) {
  if (!content) return null;
  return (
    <div className="min-w-0 break-words text-[15px] text-foreground-secondary [overflow-wrap:anywhere]">
      <ReactMarkdown
        components={components}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => sanitizeChatMarkdownUrl(url) ?? ""}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
