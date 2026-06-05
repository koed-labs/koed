import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { useEffect, useMemo, useRef } from "react";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";

import { cn } from "../lib/cn";

function setRootPlainText(value: string) {
  const root = $getRoot();
  root.clear();
  const lines = value.split("\n");
  for (const line of lines.length > 0 ? lines : [""]) {
    const paragraph = $createParagraphNode();
    if (line.length > 0) {
      paragraph.append($createTextNode(line));
    }
    root.append(paragraph);
  }
  root.selectEnd();
}

function EditorValueSyncPlugin({ value }: { value: string }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    editor.update(() => {
      if ($getRoot().getTextContent() !== value) {
        setRootPlainText(value);
      }
    });
  }, [editor, value]);

  return null;
}

function EditorEditablePlugin({ disabled }: { disabled: boolean }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  return null;
}

export function MemoryComposerEditor({
  className,
  disabled,
  height,
  onChange,
  onSubmit,
  placeholder,
  value
}: {
  className?: string;
  disabled: boolean;
  height: number;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  value: string;
}) {
  const onChangeRef = useRef(onChange);
  const valueRef = useRef(value);
  onChangeRef.current = onChange;
  valueRef.current = value;

  const initialConfig = useMemo(
    () => ({
      editable: !disabled,
      editorState: () => setRootPlainText(valueRef.current),
      namespace: "koed-memory-composer",
      onError(error: Error) {
        throw error;
      }
    }),
    []
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div
        className={cn(
          "relative overflow-hidden rounded-t-xl bg-transparent",
          disabled && "opacity-70",
          className
        )}
        style={{ height }}
      >
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              aria-label="Ask Koed memory"
              className="h-full overflow-y-auto whitespace-pre-wrap break-words px-3 py-3 text-foreground text-sm leading-relaxed outline-none"
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  onSubmit();
                }
              }}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
          placeholder={
            value.length === 0 ? (
              <div className="pointer-events-none absolute inset-0 px-3 py-3 text-muted-foreground/55 text-sm leading-relaxed">
                {placeholder}
              </div>
            ) : null
          }
        />
      </div>
      <OnChangePlugin
        onChange={(editorState) => {
          editorState.read(() => {
            const nextValue = $getRoot().getTextContent();
            if (nextValue !== valueRef.current) {
              onChangeRef.current(nextValue);
            }
          });
        }}
      />
      <EditorValueSyncPlugin value={value} />
      <EditorEditablePlugin disabled={disabled} />
    </LexicalComposer>
  );
}
