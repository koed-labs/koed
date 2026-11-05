import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { SidebarConversation } from "../project-sidebar-model.js";

export function useConversationDrag(
  onDrop?: (row: SidebarConversation, projectId: string) => void
) {
  const [over, setOver] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{
    x: number;
    y: number;
    row: SidebarConversation;
  } | null>(null);
  const gesture = useRef<{
    row: SidebarConversation;
    x: number;
    y: number;
    offsetX: number;
    offsetY: number;
    active: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const end = () => {
    gesture.current = null;
    setOver(null);
    setGhost(null);
  };
  const suppress = () => {
    suppressClick.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  };
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape" && gesture.current) {
        if (gesture.current.active) suppress();
        end();
      }
    };
    const blur = () => {
      if (gesture.current?.active) suppress();
      end();
    };
    window.addEventListener("keydown", cancel);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", cancel);
      window.removeEventListener("blur", blur);
      clearTimeout(timer.current);
    };
  }, []);
  const target = (x: number, y: number, row: SidebarConversation) => {
    const id = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>("[data-project-drop]")?.dataset.projectDrop;
    return id && id !== row.sourceProjectId ? id : null;
  };
  const handlers = (row: SidebarConversation) => ({
    draggable: false,
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (
        !onDrop ||
        !row.sessionId ||
        row.managementPending ||
        event.button !== 0 ||
        event.pointerType === "touch"
      )
        return;
      const rect = event.currentTarget.getBoundingClientRect();
      gesture.current = {
        row,
        x: event.clientX,
        y: event.clientY,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        active: false
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const g = gesture.current;
      if (!g) return;
      if (!g.active && Math.hypot(event.clientX - g.x, event.clientY - g.y) < 7)
        return;
      g.active = true;
      event.preventDefault();
      setGhost({
        x: event.clientX - g.offsetX,
        y: event.clientY - g.offsetY,
        row: g.row
      });
      setOver(target(event.clientX, event.clientY, g.row));
      const scroller =
        event.currentTarget.closest<HTMLElement>(".v1-nav-scroll");
      if (scroller) {
        const bounds = scroller.getBoundingClientRect();
        if (event.clientY < bounds.top + 35) scroller.scrollTop -= 12;
        else if (event.clientY > bounds.bottom - 35) scroller.scrollTop += 12;
      }
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const g = gesture.current;
      if (g?.active) {
        event.preventDefault();
        suppress();
        const id = target(event.clientX, event.clientY, g.row);
        if (id) onDrop?.(g.row, id);
      }
      end();
    },
    onPointerCancel: () => {
      if (gesture.current?.active) suppress();
      end();
    },
    onLostPointerCapture: () => {
      if (gesture.current?.active) suppress();
      end();
    }
  });
  return { handlers, over, ghost, suppressClick };
}
