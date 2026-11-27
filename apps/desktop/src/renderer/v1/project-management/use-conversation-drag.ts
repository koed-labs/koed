import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent
} from "react";
import type { SidebarConversation } from "../project-sidebar-model.js";

export function useConversationDrag(
  onDrop?: (row: SidebarConversation, projectId: string) => void
) {
  const [over, setOver] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{
    x: number;
    y: number;
    row: SidebarConversation;
    groupId: string;
  } | null>(null);
  const gesture = useRef<{
    row: SidebarConversation;
    groupId: string;
    pointerId: number;
    x: number;
    y: number;
    active: boolean;
    cancelled: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearFeedback = useCallback(() => {
    setOver(null);
    setGhost(null);
  }, []);
  const suppress = () => {
    suppressClick.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  };
  useEffect(() => {
    const cancel = () => {
      const current = gesture.current;
      if (!current) return;
      // Keep an active gesture until release so Escape cannot turn it into a click.
      if (current.active) current.cancelled = true;
      else gesture.current = null;
      clearFeedback();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !gesture.current) return;
      if (gesture.current.active) {
        // Escape cancels the drag before a popover can handle it.
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      cancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", cancel);
      clearTimeout(timer.current);
    };
  }, [clearFeedback]);

  const target = (x: number, y: number, row: SidebarConversation) => {
    const id = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>("[data-project-drop]")?.dataset.projectDrop;
    return id && id !== row.sourceProjectId ? id : null;
  };
  const end = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (current?.pointerId !== event.pointerId) return;
    if (current.active) suppress();
    gesture.current = null;
    clearFeedback();
  };
  const handlers = (row: SidebarConversation, groupId: string) => ({
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
      gesture.current = {
        row,
        groupId,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        active: false,
        cancelled: false
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const g = gesture.current;
      if (g?.pointerId !== event.pointerId || g.cancelled) return;
      if (!g.active && Math.hypot(event.clientX - g.x, event.clientY - g.y) < 7)
        return;
      g.active = true;
      event.preventDefault();
      setGhost({
        x: event.clientX,
        y: event.clientY,
        row: g.row,
        groupId: g.groupId
      });
      // Drop targets are Projects, which scroll on their own.
      const scroller = event.currentTarget
        .closest<HTMLElement>(".v1-nav-scroll")
        ?.querySelector<HTMLElement>(".v1-nav-projects");
      if (scroller) {
        const bounds = scroller.getBoundingClientRect();
        if (event.clientY < bounds.top + 35) scroller.scrollTop -= 12;
        else if (event.clientY > bounds.bottom - 35) scroller.scrollTop += 12;
      }
      setOver(target(event.clientX, event.clientY, g.row));
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const g = gesture.current;
      if (g?.pointerId !== event.pointerId) return;
      end(event);
      if (!g.active) return;
      event.preventDefault();
      if (g.cancelled) return;
      const id = target(event.clientX, event.clientY, g.row);
      if (id) onDrop?.(g.row, id);
    },
    onPointerCancel: end,
    onLostPointerCapture: end
  });
  return { handlers, over, ghost, suppressClick };
}
