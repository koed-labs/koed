import "./koed-logo.css";

/** Decorative brand mark beside an accessible label. Follows the resolved Desktop theme. */
export function KoedLogo({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`koed-logo ${className}`} />;
}
