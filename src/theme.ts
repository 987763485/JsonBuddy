import { useEffect, useState } from "react";
import type { Theme } from "./types";

export function useResolvedTheme(theme: Theme): "light" | "dark" {
  const [systemDark, setSystemDark] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : false
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  if (theme === "system") return systemDark ? "dark" : "light";
  return theme;
}
