import { Fragment, useMemo, type ReactNode } from "react";
import { parseMessage, type InlineNode, type ParseOptions } from "../lib/markdown.js";

/**
 * Render nội dung tin nhắn thành React element.
 *
 * Không dùng `dangerouslySetInnerHTML` ở bất kỳ đâu: parser trả về cây dữ liệu,
 * ở đây chỉ ánh xạ sang element. HTML thô trong tin nhắn vì thế luôn hiện
 * nguyên văn — an toàn XSS mà không cần sanitizer.
 */
function renderInline(nodes: InlineNode[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.type) {
      case "text":
        return <Fragment key={key}>{node.value}</Fragment>;
      case "code":
        return (
          <code
            key={key}
            className="rounded bg-slate-800/80 px-1 py-0.5 font-mono text-[0.85em] text-amber-200"
          >
            {node.value}
          </code>
        );
      case "link":
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer nofollow ugc"
            className="text-emerald-300 underline decoration-emerald-400/40 underline-offset-2 hover:decoration-emerald-300"
          >
            {node.value}
          </a>
        );
      case "mention":
        return (
          <span
            key={key}
            // Nhắc role tô màu khác nhắc người: hai thứ khác nhau (một cái đánh
            // thức một người, cái kia cả một nhóm) — cùng màu thì không phân biệt được.
            className={
              node.role === true
                ? "rounded bg-indigo-400/20 px-1 font-medium text-indigo-300"
                : "rounded bg-emerald-400/15 px-1 font-medium text-emerald-300"
            }
          >
            {node.value}
          </span>
        );
      case "strong":
        return (
          <strong key={key} className="font-semibold text-slate-50">
            {renderInline(node.children, key)}
          </strong>
        );
      case "emphasis":
        return (
          <em key={key} className="italic">
            {renderInline(node.children, key)}
          </em>
        );
      case "underline":
        return (
          <span key={key} className="underline decoration-slate-400 underline-offset-2">
            {renderInline(node.children, key)}
          </span>
        );
      case "strike":
        return (
          <s key={key} className="text-slate-400">
            {renderInline(node.children, key)}
          </s>
        );
      default:
        return null;
    }
  });
}

export function MessageContent({
  content,
  roleNames,
}: {
  content: string;
  /**
   * Tên các role của server để nhận ra `@Tên role` trong nội dung.
   *
   * Phải truyền cùng danh sách mà server dùng để ghi nhận mention, nếu không
   * sẽ có tin được tô sáng mà không ai nhận thông báo (hoặc ngược lại).
   */
  roleNames?: string[];
}) {
  const blocks = useMemo(() => {
    const options: ParseOptions = roleNames === undefined ? {} : { roleNames };
    return parseMessage(content, options);
  }, [content, roleNames]);

  if (blocks.length === 0) return null;

  return (
    <>
      {blocks.map((block, index) => {
        const key = `block-${index}`;
        if (block.type === "codeBlock") {
          return (
            <div key={key} className="my-1 overflow-hidden rounded-lg border border-white/10 bg-slate-950/80">
              {block.language !== null && (
                <div className="border-b border-white/5 px-3 py-1 text-[11px] uppercase tracking-wide text-slate-400">
                  {block.language}
                </div>
              )}
              <pre className="overflow-x-auto px-3 py-2">
                <code className="whitespace-pre font-mono text-[0.85em] text-slate-200">
                  {block.value}
                </code>
              </pre>
            </div>
          );
        }
        if (block.type === "quote") {
          return (
            <blockquote
              key={key}
              className="my-1 border-l-2 border-slate-600 pl-3 whitespace-pre-wrap break-words text-slate-300"
            >
              {renderInline(block.children, key)}
            </blockquote>
          );
        }
        return (
          <p key={key} className="whitespace-pre-wrap break-words">
            {renderInline(block.children, key)}
          </p>
        );
      })}
    </>
  );
}
