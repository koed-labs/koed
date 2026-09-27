"use client";

import {
  FileCode,
  FileSpreadsheet,
  FileText,
  FolderGit2,
  Link2,
  Video
} from "lucide-react";
import type { MemoryItemType } from "@/lib/memoryInbox";

// lucide-react dropped brand/logo icons, so GitHub and YouTube get generic
// stand-ins (a git-folder glyph, a video glyph) rather than their real
// logos - close enough to read at a glance, and consistent everywhere this
// type shows up: the add flow, the roster, and the detail panel.
const ICON_BY_TYPE: Record<MemoryItemType, typeof FileText> = {
  "github-repo": FolderGit2,
  youtube: Video,
  "web-link": Link2,
  pdf: FileText,
  docx: FileText,
  markdown: FileCode,
  csv: FileSpreadsheet,
  text: FileText
};

export function MemoryItemIcon({
  type,
  className
}: {
  type: MemoryItemType;
  className?: string;
}) {
  const Icon = ICON_BY_TYPE[type];
  return <Icon aria-hidden="true" className={className} />;
}
