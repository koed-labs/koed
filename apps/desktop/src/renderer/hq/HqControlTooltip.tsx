import {
  Tooltip,
  TooltipPopup,
  TooltipProvider,
  TooltipTrigger
} from "@koed/ui";
import type { ReactElement, ReactNode } from "react";

export function HqControlTooltip({
  label,
  children
}: {
  label: string;
  children: ReactElement<{ children?: ReactNode }>;
}) {
  return (
    <TooltipProvider delay={250}>
      <Tooltip>
        <TooltipTrigger render={children}>
          {children.props.children}
        </TooltipTrigger>
        <TooltipPopup data-hq-shell="" className="hq-tooltip">
          {label}
        </TooltipPopup>
      </Tooltip>
    </TooltipProvider>
  );
}
