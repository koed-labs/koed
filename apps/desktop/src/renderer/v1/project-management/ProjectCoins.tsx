import "./project-coins.css";

/** The count on a coin: three digits get a smaller face so they stay inside. */
const faceSize = (count: number) =>
  String(count).length >= 3 ? 9.5 : String(count).length === 2 ? 12 : 14;

function CoinFace({ count, tone }: { count: number; tone: "gold" | "silver" }) {
  // The same struck-coin construction as the Home floor coins, with a number
  // where an AI Client's mark would be. Silver is the grey of a coin not yet won.
  const c =
    tone === "gold"
      ? {
          edge: "#7a4a12",
          rim: "#e0a03a",
          face: "#ffd166",
          shine: "#fff4c2",
          ink: "#5e3a0c"
        }
      : {
          edge: "#55555c",
          rim: "#9d9da6",
          face: "#cfcfd6",
          shine: "#f4f4f8",
          ink: "#46464e"
        };
  return (
    <svg
      viewBox="0 0 32 32"
      shapeRendering="geometricPrecision"
      aria-hidden="true"
    >
      <ellipse cx="16" cy="17" rx="14.25" ry="14" fill={c.edge} />
      <circle
        cx="16"
        cy="15"
        r="14"
        fill={c.rim}
        stroke={c.edge}
        strokeWidth="1.5"
      />
      <circle
        cx="16"
        cy="14.5"
        r="12.5"
        fill={c.face}
        stroke={c.shine}
        strokeWidth="0.75"
      />
      <circle cx="16" cy="14.5" r="10.25" fill={c.rim} />
      <circle cx="16" cy="15.25" r="9.5" fill={c.face} />
      <path
        d="M6.5 11a10 10 0 0 1 12-6"
        fill="none"
        stroke={c.shine}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <text
        x="16"
        y="15.5"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={faceSize(count)}
        fontWeight="700"
        fill={c.ink}
        fontFamily="inherit"
      >
        {count}
      </text>
      {tone === "silver" && (
        <g fill="#ffffff">
          <path
            className="v1-pm-coin-sparkle"
            d="M26 3.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z"
          />
          <path
            className="v1-pm-coin-sparkle v1-pm-coin-sparkle-small"
            d="M5.5 22l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"
          />
        </g>
      )}
    </svg>
  );
}

/** A counting coin: gold counts Conversations in a Project, silver counts
 * suggestions. The count is also in the coin's label. */
export function CountCoin({
  count,
  tone
}: {
  count: number;
  tone: "gold" | "silver";
}) {
  return (
    <span
      className={`v1-pm-coin ${tone === "gold" ? "v1-pm-coin-count" : "v1-pm-coin-suggested"}`}
      role="img"
      aria-label={String(count)}
    >
      <CoinFace count={count} tone={tone} />
    </span>
  );
}

/** The silver coin on its own. */
export const SuggestionCoin = ({ count }: { count: number }) => (
  <CountCoin count={count} tone="silver" />
);
