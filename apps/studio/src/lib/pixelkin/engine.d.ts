export const PIXELKIN_EXPRESSIONS: string[];
export const PIXELKIN_PALETTES: string[];
export const PIXELKIN_SHAPES: string[];

export type PixelkinSpec = {
  seed: number;
  body: { shape: string };
  face: { expression: string };
  palette: { base: string };
  [key: string]: unknown;
};

export type PixelkinSession = {
  expressions: string[];
  palettes: string[];
  shapes: string[];
  getSpec(): PixelkinSpec;
  getState(): unknown;
  applySpec(spec: unknown): void;
  randomize(): void;
  reset(): void;
  setShape(shape: string): void;
  setPalette(hex: string): void;
  setExpression(expression: string): void;
  capturePng(size?: number): string;
  destroy(): void;
};

export function createPixelkinSession(
  canvas: HTMLCanvasElement,
  onChange?: (spec: PixelkinSpec) => void
): PixelkinSession;
