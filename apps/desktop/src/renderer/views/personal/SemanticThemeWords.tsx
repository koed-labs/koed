export function SemanticThemeWords({ themes }: { themes: readonly string[] }) {
  if (!themes.length) return null;

  return (
    <span
      className="semantic-theme-cloud"
      aria-label={`Key themes: ${themes.join(", ")}`}
    >
      {themes.map((theme, index) => (
        <span data-weight={Math.max(1, 3 - index)} key={theme}>
          {theme}
        </span>
      ))}
    </span>
  );
}
