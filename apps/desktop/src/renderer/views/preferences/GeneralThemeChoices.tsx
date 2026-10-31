import { Check, Sun, Moon, Monitor } from "lucide-react";
import type { DesktopThemePreference } from "../../../window/theme-preference.js";
export function GeneralThemeChoices({
  theme,
  onThemeChange
}: {
  theme: DesktopThemePreference;
  onThemeChange: (theme: DesktopThemePreference) => void;
}) {
  return (
    <fieldset className="koed-general-themes">
      <legend className="koed-visually-hidden">Theme</legend>
      {(
        [
          ["light", Sun],
          ["dark", Moon],
          ["system", Monitor]
        ] as const
      ).map(([value, Icon]) => (
        <label key={value} data-selected={theme === value}>
          <input
            type="radio"
            name="theme"
            value={value}
            checked={theme === value}
            onChange={() => onThemeChange(value)}
          />
          <span
            className={`koed-general-theme-preview koed-preview-${value}`}
            aria-hidden="true"
          >
            <span className="koed-mini-rail">
              <i />
              <i />
              <i />
            </span>
            <span className="koed-mini-sidebar">
              <i />
              <i />
              <i />
            </span>
            <span className="koed-mini-main">
              <i />
              <i />
              <span />
              <span />
            </span>
          </span>
          <span className="koed-general-theme-label">
            <Icon size={14} />
            <span>{value[0]!.toUpperCase() + value.slice(1)}</span>
            {theme === value && <Check size={14} />}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
