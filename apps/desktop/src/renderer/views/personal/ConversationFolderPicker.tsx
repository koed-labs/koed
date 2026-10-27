import { Check, ChevronDown, Folder, FolderOpen } from "lucide-react";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuLabel,
  DropdownMenuPopup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from "@koed/ui";

export type ConversationFolderPickerProps = {
  folders: readonly { id: string; path: string }[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  disabledReason?: string;
  placeholder?: string;
};

const folderName = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** Folder paths label native choices. The opaque identity selects execution. */
export function ConversationFolderPicker({
  folders,
  selectedId,
  onSelect,
  disabledReason,
  placeholder = "Choose Folder"
}: ConversationFolderPickerProps) {
  const [open, setOpen] = useState(false);
  const selected = folders.find((folder) => folder.id === selectedId);
  const reason =
    disabledReason ??
    (folders.length ? undefined : "No local Folder is available.");
  return (
    <DropdownMenu
      open={!reason && open}
      onOpenChange={(next) => setOpen(!reason && next)}
    >
      <DropdownMenuTrigger
        className={`conversation-folder-trigger${selected ? " is-selected" : ""}`}
        aria-label={`Execution Folder: ${selected?.path ?? placeholder}`}
        disabled={Boolean(reason)}
        title={reason ?? selected?.path ?? placeholder}
      >
        <Folder aria-hidden="true" />
        <span>{selected ? folderName(selected.path) : placeholder}</span>
        <ChevronDown aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuPopup
        side="top"
        align="start"
        sideOffset={10}
        className="conversation-folder-popup"
        aria-label="Local Folders"
      >
        <DropdownMenuRadioGroup
          value={selected?.id ?? ""}
          onValueChange={(id) => {
            if (!reason && folders.some((folder) => folder.id === id)) {
              onSelect(id);
              setOpen(false);
            }
          }}
        >
          <DropdownMenuLabel>Local Folders</DropdownMenuLabel>
          {folders.map((folder) => (
            <DropdownMenuRadioItem
              key={folder.id}
              value={folder.id}
              className="conversation-folder-option"
              title={folder.path}
            >
              <FolderOpen aria-hidden="true" />
              <span>
                <strong>{folderName(folder.path)}</strong>
                <small>{folder.path}</small>
              </span>
              {folder.id === selected?.id ? <Check aria-hidden="true" /> : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuPopup>
    </DropdownMenu>
  );
}
