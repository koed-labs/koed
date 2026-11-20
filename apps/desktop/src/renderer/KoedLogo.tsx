import "./koed-logo.css";

/**
 * Decorative brand mark beside an accessible label. Follows the resolved
 * Desktop theme, or stays the two-tone colour mark when `color` is set.
 */
export function KoedLogo({
  className = "",
  color = false
}: {
  className?: string;
  color?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`koed-logo ${color ? "koed-logo-color" : ""} ${className}`}
    />
  );
}
