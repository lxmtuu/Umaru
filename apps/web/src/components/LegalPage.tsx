import type { ReactNode } from "react";
import { useLocale, useT } from "../lib/i18n.js";
import { LEGAL_DOCS, type LegalDocId } from "../lib/legal.js";
import { legalPath, readLegalLocale } from "../lib/legalRoute.js";

/**
 * In đậm bằng cặp `**...**` (văn bản pháp lý chỉ cần đúng một kiểu nhấn mạnh).
 * Tách chuỗi thay vì render HTML để nội dung không bao giờ thành markup lạ.
 */
function emphasize(text: string): ReactNode[] {
  return text.split(/\*\*(.+?)\*\*/g).map((part, index) =>
    index % 2 === 1 ? (
      <strong key={index} className="font-semibold text-slate-100">
        {part}
      </strong>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}

/**
 * Trang Điều khoản / Chính sách — mở được **khi chưa đăng nhập** (link từ màn
 * đăng nhập, email, hoặc dán thẳng URL), không phụ thuộc phiên.
 *
 * Nội dung lấy từ `lib/legal.ts`; ngôn ngữ ưu tiên `?lang=` trên URL rồi mới
 * tới ngôn ngữ đang chọn trong app.
 */
export function LegalPage({ doc }: { doc: LegalDocId }) {
  const t = useT();
  const locale = useLocale((state) => state.locale);
  const search = typeof window === "undefined" ? "" : window.location.search;
  const lang = readLegalLocale(search, locale);
  const content = LEGAL_DOCS[doc][lang];
  const other = lang === "vi" ? "en" : "vi";

  return (
    <div className="min-h-screen overflow-y-auto bg-slate-950 text-slate-200">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <nav className="mb-6 flex flex-wrap items-center gap-3 text-xs text-slate-400">
          <a href="/" className="rounded border border-white/10 px-2 py-1 hover:bg-white/5 hover:text-slate-100">
            ← {t("backToApp")}
          </a>
          <a
            href={legalPath(doc === "terms" ? "privacy" : "terms", lang)}
            className="rounded border border-white/10 px-2 py-1 hover:bg-white/5 hover:text-slate-100"
          >
            {doc === "terms" ? t("privacyPolicy") : t("termsOfService")}
          </a>
          <a
            href={`${legalPath(doc, other)}`}
            className="ml-auto rounded border border-white/10 px-2 py-1 hover:bg-white/5 hover:text-slate-100"
          >
            {other === "en" ? "English" : "Tiếng Việt"}
          </a>
        </nav>

        <h1 className="text-2xl font-semibold text-slate-50">{content.title}</h1>
        <p className="mt-1 text-xs text-slate-500">
          {t("legalUpdated")}: {content.updated}
        </p>

        <div className="mt-4 space-y-3 text-sm leading-relaxed text-slate-300">
          {content.intro.map((paragraph, index) => (
            <p key={index}>{emphasize(paragraph)}</p>
          ))}
        </div>

        <div className="mt-8 space-y-6">
          {content.sections.map((section) => (
            <section key={section.heading}>
              <h2 className="text-sm font-semibold text-slate-100">{section.heading}</h2>
              <div className="mt-2 space-y-2 text-sm leading-relaxed text-slate-300">
                {section.paragraphs.map((paragraph, index) => (
                  <p key={index}>{emphasize(paragraph)}</p>
                ))}
                {section.bullets !== undefined && (
                  <ul className="list-disc space-y-1 pl-5">
                    {section.bullets.map((bullet, index) => (
                      <li key={index}>{emphasize(bullet)}</li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          ))}
        </div>

        <p className="mt-10 border-t border-white/10 pt-4 text-xs text-slate-500">
          {t("legalDraftNotice")}
        </p>
      </div>
    </div>
  );
}
