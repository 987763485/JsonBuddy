import { useCallback } from "react";
import { translate, type MessageKey } from "./i18n";
import { useAppStore } from "./store";

export function useT() {
  const language = useAppStore((state) => state.settings.language);
  return useCallback(
    (key: MessageKey, values?: Record<string, string | number>) =>
      translate(language, key, values),
    [language]
  );
}
