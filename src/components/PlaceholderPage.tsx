import { Boxes } from "lucide-react";
import type { MessageKey } from "../i18n";
import { useT } from "../useT";

interface PlaceholderPageProps {
  title: MessageKey;
  body: MessageKey;
}

export function PlaceholderPage({ title, body }: PlaceholderPageProps) {
  const t = useT();
  return (
    <section className="placeholder-page">
      <div className="placeholder-card">
        <span className="placeholder-icon">
          <Boxes size={26} />
        </span>
        <span className="eyebrow">{t("placeholder.planned")}</span>
        <h1>{t(title)}</h1>
        <p>{t(body)}</p>
        <small>{t("placeholder.ready")}</small>
      </div>
    </section>
  );
}
