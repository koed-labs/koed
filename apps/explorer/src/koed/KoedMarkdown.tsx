import { CheckIcon, CopyIcon } from "lucide-react";
import { Children, isValidElement, useState, type ReactNode } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button, cn } from "@koed/ui";

interface KoedMarkdownProps {
  className?: string;
  text: string;
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function extractCodeBlock(children: ReactNode): string | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }
  const onlyChild = childNodes[0];
  if (!isValidElement<{ children?: ReactNode }>(onlyChild)) {
    return null;
  }
  return nodeToPlainText(onlyChild.props.children).replace(/\n$/, "");
}

function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      aria-label={copied ? "Copied code" : "Copy code"}
      className="chat-markdown-copy-button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void navigator.clipboard.writeText(code).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
      size="icon-xs"
      type="button"
      variant="ghost"
    >
      {copied ? (
        <CheckIcon className="size-3.5" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </Button>
  );
}

const markdownComponents: Components = {
  a({ children, href, ...props }) {
    return (
      <a
        {...props}
        href={href}
        rel="noreferrer"
        target={href?.startsWith("#") ? undefined : "_blank"}
      >
        {children}
      </a>
    );
  },
  pre({ children, ...props }) {
    const code = extractCodeBlock(children);

    return (
      <div className="chat-markdown-codeblock leading-snug">
        {code !== null ? <CopyCodeButton code={code} /> : null}
        <pre {...props}>{children}</pre>
      </div>
    );
  }
};

export function KoedMarkdown({ className, text }: KoedMarkdownProps) {
  return (
    <div
      className={cn(
        "chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80",
        className
      )}
    >
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={[remarkGfm]}
        urlTransform={defaultUrlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
