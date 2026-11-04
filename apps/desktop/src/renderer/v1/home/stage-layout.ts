// Home's stages are drawn in design units and scaled to the stage, so one
// arrangement works from the smallest window to a large display. Kin scale;
// their labels keep a readable fixed size, so the fit allows for them.
export type StageSlot = {
  // Design units from the stage's centre line.
  x: number;
  // Design units above the floor.
  y: number;
  // Kin size in design units.
  size: number;
  // Label height in pixels; 0 when the Kin has no label.
  label: number;
};

export type StageBox = { width: number; height: number };

export type StagePlacement = {
  // Pixels from the centre line, and from the stage's bottom edge.
  x: number;
  bottom: number;
  size: number;
};

export type StageLayout = {
  scale: number;
  placements: StagePlacement[];
  // Where the spotlight lands: the first slot's feet.
  spot: { x: number; bottom: number; size: number };
};

// The Kin's ground shadow adds this share of its size; the flex gaps around
// it add a fixed amount.
const SHADOW = 0.12;
const GAPS = 6;
// Labels are capped at this width, so half of it is the most they overhang.
export const STAGE_LABEL_WIDTH = 150;
const PAD = 20;
export const STAGE_MIN_SCALE = 0.5;
export const STAGE_MAX_SCALE = 1.6;

const top = (slot: StageSlot, scale: number) =>
  (slot.y + slot.size * (1 + SHADOW)) * scale + GAPS + slot.label;

/**
 * Fits the slots into the space above `reserve` (the caption). Without a
 * measured box the layout falls back to design size.
 */
export function layoutStage(
  box: StageBox | null,
  reserve: number,
  slots: readonly StageSlot[]
): StageLayout {
  let scale = 1;
  let lift = 0;
  if (box && box.width > 0 && box.height > 0) {
    const room = box.height - reserve - PAD;
    const half = box.width / 2 - PAD;
    let fit = STAGE_MAX_SCALE;
    for (const slot of slots) {
      fit = Math.min(
        fit,
        (room - GAPS - slot.label) / (slot.y + slot.size * (1 + SHADOW)),
        half / (Math.abs(slot.x) + slot.size / 2)
      );
      if (slot.x && slot.label)
        fit = Math.min(fit, (half - STAGE_LABEL_WIDTH / 2) / Math.abs(slot.x));
    }
    scale = Math.max(STAGE_MIN_SCALE, fit);
    // Spare height goes partly under the Kin so they don't sit on the caption.
    const used = Math.max(...slots.map((slot) => top(slot, scale)));
    lift = Math.max(0, Math.min((room - used) * 0.3, 80));
  }
  const floor = reserve + lift;
  const placements = slots.map((slot) => ({
    x: Math.round(slot.x * scale),
    bottom: Math.round(floor + slot.y * scale),
    size: Math.round(slot.size * scale)
  }));
  const lead = slots[0]!;
  const leadAt = placements[0]!;
  return {
    scale,
    placements,
    spot: {
      x: leadAt.x,
      // The shadow under the lead Kin, just above its label.
      bottom: Math.round(leadAt.bottom + lead.label + 8 + leadAt.size * 0.06),
      size: leadAt.size
    }
  };
}
