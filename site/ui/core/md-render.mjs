// 聊天回复的 Markdown → VitePress 同款 HTML 渲染器（纯浏览器端、无 Node 依赖）。
// 输出结构（custom-block、language-* 外壳、<code> 高亮类）须与 docs 站点主题
// 配套的样式（tui-base.css 等）对上，否则富文本在聊天气泡里会走样。
import MarkdownIt from "markdown-it";
import container from "markdown-it-container";

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
});

function addCustomBlock(name, { element = "div", withTitle = true, defaultTitle = name.toUpperCase() } = {}) {
  md.use(container, name, {
    validate: (p) => p.trim().length > 0,
    render(tokens, idx) {
      const t = tokens[idx];
      if (t.nesting === 1) {
        const raw = t.info.trim().slice(name.length).trim();
        const title = raw || defaultTitle;
        const titleHtml = withTitle
          ? `<p class="custom-block-title">${escapeHtml(title)}</p>`
          : "";
        if (element === "details") {
          return `<details class="custom-block ${name}"><summary>${escapeHtml(title)}</summary>\n`;
        }
        return `<div class="custom-block ${name}">${titleHtml}\n`;
      }
      return element === "details" ? "</details>\n" : "</div>\n";
    },
  });
}

addCustomBlock("tip", { defaultTitle: "TIP" });
addCustomBlock("info", { defaultTitle: "INFO" });
addCustomBlock("warning", { defaultTitle: "WARNING" });
addCustomBlock("danger", { defaultTitle: "DANGER" });
addCustomBlock("details", { element: "details", withTitle: false });

// 代码块 -> VitePress 的 language-* 外壳（带语言角标），保证和文档页代码块外观一致
md.renderer.rules.fence = (tokens, idx) => {
  const t = tokens[idx];
  const lang = (t.info || "").trim().split(/\s+/)[0];
  const code = escapeHtml(t.content);
  const cls = lang ? `language-${escapeHtml(lang)}` : "";
  const langSpan = lang ? `<span class="lang">${escapeHtml(lang)}</span>` : "";
  return `<div class="${cls}">${langSpan}<pre><code class="${cls}">${code}</code></pre></div>\n`;
};

export function renderMarkdown(src) {
  return md.render(src ?? "");
}

/** 尝试解析模型偶尔裹一层 {"markdown": ...} 的情况 */
export function unwrapMarkdown(text) {
  const s = String(text ?? "").trim();
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      if (typeof j.markdown === "string") return j.markdown;
    } catch {
      /* fall through */
    }
    // 容错：去掉最外层花括号再试一次
    const m = s.match(/^\s*\{\s*"markdown"\s*:\s*("(?:\\.|[^"\\])*")\s*\}\s*$/s);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {
        /* ignore */
      }
    }
  }
  return s;
}
