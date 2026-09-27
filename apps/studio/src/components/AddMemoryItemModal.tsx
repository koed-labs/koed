"use client";

import { useEffect, useRef, useState } from "react";
import { Link2, Upload, X } from "lucide-react";
import {
  MEMORY_ITEM_TYPE_LABEL,
  detectFileType,
  detectLinkType,
  titleFromFileName,
  titleFromLink,
  type MemoryItemType
} from "@/lib/memoryInbox";
import { useWorkspace } from "./WorkspaceProvider";
import { MemoryItemIcon } from "./MemoryItemIcon";

type Mode = "link" | "file";

const ACCEPTED_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".doc",
  ".md",
  ".markdown",
  ".csv",
  ".txt"
];

// Creates local preview metadata only. It does not upload or process sources.
export function AddMemoryItemModal({
  onClose,
  onAdded
}: {
  onClose: () => void;
  onAdded: (itemId: string) => void;
}) {
  const { addMemoryItem } = useWorkspace();
  const [mode, setMode] = useState<Mode>("link");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [tagsInput, setTagsInput] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const detectedType: MemoryItemType | null =
    mode === "link"
      ? url.trim()
        ? detectLinkType(url.trim())
        : null
      : file
        ? detectFileType(file.name)
        : null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Suggested title derived from the source, unless the person has already
  // typed their own - never clobber an edit they made. Computed at render
  // time rather than synced via an effect, so there is no extra render pass.
  const suggestedTitle =
    mode === "link" && url.trim() && detectedType
      ? titleFromLink(url.trim(), detectedType)
      : mode === "file" && file
        ? titleFromFileName(file.name)
        : "";
  const displayTitle = titleTouched ? title : suggestedTitle;

  const chooseFile = (picked: File | null) => {
    if (!picked) return;
    const lowerName = picked.name.toLowerCase();
    if (
      !ACCEPTED_EXTENSIONS.some((extension) => lowerName.endsWith(extension))
    ) {
      setFile(null);
      setError("Choose a PDF, DOCX, Markdown, CSV, or text file.");
      return;
    }
    setFile(picked);
    setError(null);
  };

  const submit = () => {
    const trimmedTitle = displayTitle.trim();
    if (!trimmedTitle) {
      setError("Give it a title first.");
      return;
    }
    if (mode === "link") {
      if (!url.trim()) {
        setError("Paste a link first.");
        return;
      }
      try {
        const parsed = new URL(url.trim());
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          setError("Use an http or https link.");
          return;
        }
      } catch {
        setError("Enter a valid http or https link.");
        return;
      }
      const type = detectLinkType(url.trim());
      const item = addMemoryItem({
        type,
        title: trimmedTitle,
        source: url.trim(),
        tags: tagsInput
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
      });
      onAdded(item.id);
      return;
    }
    if (!file) {
      setError("Choose a file first.");
      return;
    }
    const type = detectFileType(file.name);
    const item = addMemoryItem({
      type,
      title: trimmedTitle,
      source: file.name,
      tags: tagsInput
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
    });
    onAdded(item.id);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm no-drag"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-preview-item-title"
        className="flex max-h-[calc(100vh-2rem)] w-[480px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4">
          <h2
            id="add-preview-item-title"
            className="text-base font-semibold text-foreground"
          >
            Add to Memory Inbox
          </h2>
          <button
            type="button"
            className="rounded-md p-1 text-subtle hover:bg-surface-hover hover:text-foreground-secondary"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          <p className="rounded-md border border-warning/30 bg-warning/10 p-3 text-xs leading-5 text-foreground-secondary">
            Preview only. Koed does not fetch links or upload, save, or process
            file contents here. Only the URL or filename, title, and tags are
            kept as local preview metadata.
          </p>
          <div className="flex gap-1 rounded-lg bg-background p-1">
            <button
              type="button"
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition-colors ${
                mode === "link"
                  ? "bg-chip text-chip-foreground"
                  : "text-muted hover:text-foreground-secondary"
              }`}
              onClick={() => {
                setMode("link");
                setError(null);
              }}
            >
              <Link2 className="h-3.5 w-3.5" />
              Link preview
            </button>
            <button
              type="button"
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition-colors ${
                mode === "file"
                  ? "bg-chip text-chip-foreground"
                  : "text-muted hover:text-foreground-secondary"
              }`}
              onClick={() => {
                setMode("file");
                setError(null);
              }}
            >
              <Upload className="h-3.5 w-3.5" />
              File name preview
            </button>
          </div>

          {mode === "link" ? (
            <label className="mt-4 block">
              <span className="mb-2 block text-sm text-muted">
                Link (metadata only)
              </span>
              <input
                autoFocus
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://github.com/owner/repo, a YouTube link, an article…"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-faint focus:border-border-strong"
              />
            </label>
          ) : (
            <div className="mt-4">
              <span className="mb-2 block text-sm text-muted">
                File name only
              </span>
              <div
                className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors ${
                  dragOver
                    ? "border-border-strong bg-surface-hover"
                    : "border-border bg-background"
                }`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragOver(false);
                  chooseFile(event.dataTransfer.files?.[0] ?? null);
                }}
              >
                <Upload className="h-5 w-5 text-subtle" />
                {file ? (
                  <p className="text-sm text-foreground-secondary">
                    {file.name}
                  </p>
                ) : (
                  <>
                    <p className="text-sm text-foreground-secondary">
                      Choose a file to preview its name, or
                    </p>
                    <button
                      type="button"
                      className="text-sm font-medium text-accent hover:underline"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      browse your files
                    </button>
                  </>
                )}
                <p className="text-[11px] text-subtle">
                  Only the filename is kept. File bytes remain unused.
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_EXTENSIONS.join(",")}
                  className="hidden"
                  onChange={(event) =>
                    chooseFile(event.target.files?.[0] ?? null)
                  }
                />
              </div>
            </div>
          )}

          {detectedType && (
            <div className="mt-3 flex items-center gap-1.5 text-xs text-subtle">
              <MemoryItemIcon type={detectedType} className="h-3.5 w-3.5" />
              Detected as {MEMORY_ITEM_TYPE_LABEL[detectedType]}
            </div>
          )}

          <label className="mt-4 block">
            <span className="mb-2 block text-sm text-muted">Title</span>
            <input
              value={displayTitle}
              onChange={(event) => {
                setTitle(event.target.value);
                setTitleTouched(true);
              }}
              placeholder="What should this be called?"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-faint focus:border-border-strong"
            />
          </label>

          <label className="mt-4 block">
            <span className="mb-2 block text-sm text-muted">
              Tags (optional, local preview)
            </span>
            <input
              value={tagsInput}
              onChange={(event) => setTagsInput(event.target.value)}
              placeholder="onboarding, backend, q3-research…"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-faint focus:border-border-strong"
            />
            <span className="mt-1.5 block text-[11px] text-subtle">
              Comma-separated. Helps you find it later.
            </span>
          </label>

          {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        </div>

        <div className="flex justify-end border-t border-border bg-background/40 px-5 py-3">
          <button
            type="button"
            className="rounded-lg bg-chip px-4 py-2 text-sm font-medium text-chip-foreground hover:bg-white"
            onClick={submit}
          >
            Add to Memory Inbox
          </button>
        </div>
      </div>
    </div>
  );
}
