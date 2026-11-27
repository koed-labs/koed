import type { SupportedAiClientDriverId } from "@koed-labs/shared/ai-client-contract";
import { AiClientLogo } from "../../views/personal/AiClientLogo.js";

export type CoinClient = SupportedAiClientDriverId | null;

/**
 * A Conversation's coin as vector art: the fallback when kin-engine can't
 * draw (no WebGL2).
 * Vector edges retain detail while the coins scale, flatten and tumble.
 */
export function CoinArtwork({ client = null }: { client?: CoinClient }) {
  return (
    <svg
      viewBox="0 0 32 32"
      shapeRendering="geometricPrecision"
      aria-hidden="true"
    >
      <ellipse cx="16" cy="17" rx="14.25" ry="14" fill="#7a4a12" />
      <circle
        cx="16"
        cy="15"
        r="14"
        fill="#e0a03a"
        stroke="#7a4a12"
        strokeWidth="1.5"
      />
      <circle
        cx="16"
        cy="14.5"
        r="12.5"
        fill="#ffd166"
        stroke="#fff4c2"
        strokeWidth="0.75"
      />
      <circle cx="16" cy="14.5" r="10.25" fill="#e0a03a" />
      <circle cx="16" cy="15.25" r="9.5" fill="#ffd166" />
      <path
        d="M6.5 11a10 10 0 0 1 12-6"
        fill="none"
        stroke="#fff4c2"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {client ? (
        // The originating AI Client's mark, struck into the coin.
        <svg x="9.25" y="8" width="13.5" height="13.5" fill="#7a4a12">
          <AiClientLogo id={client} />
        </svg>
      ) : (
        <>
          <rect x="12.5" y="11.5" width="7" height="7" rx="1" fill="#7a4a12" />
          <path
            d="M13 18.5h5.5a1 1 0 0 0 1-1V12"
            fill="none"
            stroke="#fff4c2"
            strokeWidth="0.75"
          />
        </>
      )}
    </svg>
  );
}
