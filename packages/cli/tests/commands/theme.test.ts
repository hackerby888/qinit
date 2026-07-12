import { test, expect } from "bun:test";
import { applyTheme, theme, THEMES, THEME_NAMES } from "../../src/ui";

test("applyTheme switches the live palette; unknown falls back to default", () => {
  expect(applyTheme("amber")).toBe("amber");
  expect(theme.brand).toBe(THEMES.amber.brand);
  expect(theme.gradFrom).toBe(THEMES.amber.gradFrom);

  expect(applyTheme("nope")).toBe("default");      // unknown -> default
  expect(theme.brand).toBe(THEMES.default.brand);

  expect(applyTheme(undefined)).toBe("default");   // unset -> default
  expect(theme.brand).toBe(THEMES.default.brand);
});

test("every theme defines all palette keys", () => {
  const keys = Object.keys(THEMES.default);
  for (const name of THEME_NAMES) {
    for (const k of keys) expect(typeof (THEMES[name] as any)[k]).toBe("string");
  }
});
