"use client";

import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "../cn.js";

/** Single-value slider with the same Base UI behavior and tokens as our inputs. */
export function Slider({
  className,
  label,
  valueText,
  ...props
}: SliderPrimitive.Root.Props<number> & {
  label: string;
  valueText?: string;
}) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn("w-full data-disabled:opacity-50", className)}
      {...props}
    >
      <SliderPrimitive.Control className="flex h-5 w-full touch-none items-center select-none">
        <SliderPrimitive.Track className="relative h-1.5 w-full rounded-full bg-muted">
          <SliderPrimitive.Indicator className="rounded-full bg-primary" />
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            aria-label={label}
            getAriaValueText={valueText ? () => valueText : undefined}
            className="size-4 rounded-full border border-primary bg-background shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}
