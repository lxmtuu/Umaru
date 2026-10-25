import type { AdminReport, ReportStatus } from "@umaru/protocol";
import { useEffect } from "react";
import { useChat } from "../lib/chatStore.js";
import { useLocale, useT } from "../lib/i18n.js";
import { reasonLabel } from "./SafetyPanels.js";

const TABS: ReportStatus[] = ["open", "reviewing", "closed"];

const TAB_LABEL: Record<ReportStatus, "statusOpen" | "statusReviewing" | "statusClosed"> = {
  open: "statusOpen",
  reviewing: "statusReviewing",
  closed: "statusClosed",
};

/**
 * Hàng đợi báo cáo vi phạm cho người vận hành.
 *
 * Mở bằng đường dẫn riêng `/admin/reports` để không lẫn với khung chat, và để
 * bookmark được khi cần trực chiến. Quyền thật do server kiểm
 * (`/admin/reports` trả 403 với người không phải admin); trang này chỉ ẩn nội
 * dung khi biết chắc không có quyền.
 */
export function AdminReportsPage() {
  const t = useT();
  const locale = useLocale((state) => state.locale);
  const state = useChat();

  useEffect(() => {
    // Chỉ tải khi đã có phiên; chưa đăng nhập thì hiện lời nhắc bên dưới.
    if (state.screen !== "chat") return;
    if (state.admin === null) {
      void state.checkAdmin().then((admin) => {
        if (admin) void state.loadAdminReports();
      });
      return;
    }
    if (state.admin && state.adminReports === null && !state.adminLoading) {
      void state.loadAdminReports();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.screen, state.admin]);

  if (state.screen !== "chat") {
    return <Shell title={t("adminReports")} hint={t("adminNeedsLogin")} />;
  }
  if (state.admin === false) {
    return <Shell title={t("adminReports")} hint={t("adminForbidden")} />;
  }
  if (state.admin === null) {
    return <Shell title={t("adminReports")} hint={t("loading")} />;
  }

  return (
    <div className="min-h-screen overflow-y-auto bg-slate-950 text-slate-200">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <nav className="mb-4 flex items-center gap-3 text-xs text-slate-400">
          <a
            href="/"
            className="rounded border border-white/10 px-2 py-1 hover:bg-white/5 hover:text-slate-100"
          >
            ← {t("backToApp")}
          </a>
          <span className="ml-auto">
            {state.me?.displayName} · {t("adminBadge")}
          </span>
        </nav>

        <h1 className="text-xl font-semibold text-slate-50">{t("adminReports")}</h1>

        <div className="mt-4 flex flex-wrap gap-1 text-xs">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => void state.loadAdminReports(tab)}
              aria-pressed={state.adminStatusFilter === tab}
              className={`rounded-lg border px-2.5 py-1 ${
                state.adminStatusFilter === tab
                  ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-200"
                  : "border-white/10 text-slate-400 hover:bg-white/5"
              }`}
            >
              {t(TAB_LABEL[tab])}
              {state.adminCounts !== null && (
                <span className="ml-1.5 opacity-70">{state.adminCounts[tab]}</span>
              )}
            </button>
          ))}
          <button
            onClick={() => void state.loadAdminReports()}
            className="ml-auto rounded-lg border border-white/10 px-2.5 py-1 text-slate-400 hover:bg-white/5"
          >
            {t("refresh")}
          </button>
        </div>

        {state.error !== null && (
          <p className="mt-3 rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">
            {state.error}
          </p>
        )}

        {state.adminLoading && state.adminReports === null ? (
          <p className="mt-6 text-sm text-slate-500">{t("loading")}</p>
        ) : state.adminReports !== null && state.adminReports.length === 0 ? (
          <p className="mt-6 text-sm text-slate-500">{t("adminEmptyQueue")}</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {(state.adminReports ?? []).map((report) => (
              <ReportCard
                key={report.id}
                report={report}
                locale={locale}
                busy={state.adminLoading}
                onStatus={(status) => void state.updateReportStatus(report.id as string, status)}
                labels={{
                  report: t("reportShort"),
                  reporter: t("reporter"),
                  target: t("reportedUser"),
                  details: t("reportDetailsLabel"),
                  snapshot: t("snapshot"),
                  messageDeleted: t("messageGone"),
                  reviewing: t("markReviewing"),
                  closed: t("markClosed"),
                  reopen: t("markOpen"),
                  reason: t("reportReason"),
                }}
              />
            ))}
          </ul>
        )}

        {state.adminHasMore && (
          <div className="mt-4">
            <button
              onClick={() => void state.loadMoreAdminReports()}
              disabled={state.adminLoading}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10 disabled:opacity-40"
            >
              {state.adminLoading ? t("loading") : t("loadMore")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Shell({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="grid min-h-screen place-items-center bg-slate-950 px-6 text-center">
      <div>
        <h1 className="text-lg font-semibold text-slate-100">{title}</h1>
        <p className="mt-2 max-w-md text-sm text-slate-400">{hint}</p>
        <a
          href="/"
          className="mt-4 inline-block rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
        >
          ← Umaru
        </a>
      </div>
    </div>
  );
}

function ReportCard({
  report,
  locale,
  busy,
  onStatus,
  labels,
}: {
  report: AdminReport;
  locale: string;
  busy: boolean;
  onStatus: (status: ReportStatus) => void;
  labels: Record<string, string>;
}) {
  const where =
    report.guildName !== null
      ? `#${report.channelName ?? "?"} · ${report.guildName}`
      : report.channelName !== null
        ? `#${report.channelName}`
        : "—";

  return (
    <li className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="flex flex-wrap items-baseline gap-2 text-[11px] text-slate-500">
        <span className="rounded bg-rose-400/10 px-1.5 py-0.5 font-medium text-rose-200">
          {reasonLabel(report.reason)}
        </span>
        <span>{where}</span>
        <span className="ml-auto">
          {new Date(report.createdAt).toLocaleString(locale, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
        <span className="rounded bg-white/5 px-1.5 py-0.5">#{report.id}</span>
      </div>

      <p className="mt-2 text-xs text-slate-400">
        {labels.reporter}:{" "}
        <span className="text-slate-200">{report.reporter.displayName}</span>{" "}
        <span className="opacity-60">@{report.reporter.username}</span>
        {"  ·  "}
        {labels.target}:{" "}
        <span className="text-slate-200">{report.target.displayName}</span>{" "}
        <span className="opacity-60">@{report.target.username}</span>
      </p>

      <div className="mt-2">
        <p className="text-[10px] uppercase tracking-wide text-slate-500">{labels.snapshot}</p>
        <p className="mt-0.5 whitespace-pre-wrap break-words rounded-lg bg-slate-950/60 px-2 py-1.5 text-sm text-slate-200">
          {report.snapshotContent !== null && report.snapshotContent.length > 0
            ? report.snapshotContent
            : report.messageId !== null
              ? labels.messageDeleted
              : "—"}
        </p>
      </div>

      {report.details !== null && (
        <div className="mt-2">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">{labels.details}</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-slate-300">
            {report.details}
          </p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
        {report.status !== "reviewing" && (
          <button
            onClick={() => onStatus("reviewing")}
            disabled={busy}
            className="rounded border border-amber-300/30 bg-amber-400/10 px-2 py-1 text-amber-200 hover:bg-amber-400/20 disabled:opacity-40"
          >
            {labels.reviewing}
          </button>
        )}
        {report.status !== "closed" ? (
          <button
            onClick={() => onStatus("closed")}
            disabled={busy}
            className="rounded border border-emerald-300/30 bg-emerald-400/10 px-2 py-1 text-emerald-200 hover:bg-emerald-400/20 disabled:opacity-40"
          >
            {labels.closed}
          </button>
        ) : (
          <button
            onClick={() => onStatus("open")}
            disabled={busy}
            className="rounded border border-white/10 px-2 py-1 text-slate-300 hover:bg-white/5 disabled:opacity-40"
          >
            {labels.reopen}
          </button>
        )}
      </div>
    </li>
  );
}
