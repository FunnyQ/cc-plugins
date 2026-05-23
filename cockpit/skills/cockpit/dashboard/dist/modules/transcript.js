// Live-transcript column — streams a Claude Code session transcript over SSE and
// renders it like token-atlas's live view: prose as Markdown, thinking as a
// muted badge, tool calls/results as highlighted code, file edits as inline
// diffs, Read results with a line-number gutter. Imperative (not petite-vue
// reactive): each entry's HTML is built ONCE on receipt (cached on the entry)
// and never re-run on store polls. Claude Code transcripts only.
import { store } from "../app.js";
import { marked } from "../vendor/marked.esm.js";
import DOMPurify from "../vendor/purify.es.mjs";
import hljs from "../vendor/highlight.esm.js";

// Code/tool-result blocks taller than this collapse into a <details> by default.
const STREAM_COLLAPSE_LINES = 10;

const fmtNum = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString() : String(n);
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char];
  });
}

function unescapeXml(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function readXmlTag(text, tag) {
  const match = String(text).match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? unescapeXml(match[1].trim()) : "";
}

function parseTaskNotification(text) {
  const raw = String(text).trim();
  if (!raw.startsWith("<task-notification>")) return null;
  const usage = readXmlTag(raw, "usage");
  return {
    status: readXmlTag(raw, "status") || "completed",
    summary: readXmlTag(raw, "summary") || "Task completed",
    result: readXmlTag(raw, "result"),
    totalTokens: readXmlTag(usage, "total_tokens"),
    toolUses: readXmlTag(usage, "tool_uses"),
    durationMs: readXmlTag(usage, "duration_ms"),
  };
}

function parseSubagentNotification(text) {
  const raw = String(text).trim();
  if (!raw.startsWith("<subagent_notification>")) return null;
  const body = raw
    .replace(/^<subagent_notification>/, "")
    .replace(/<\/subagent_notification>$/, "")
    .trim();
  try {
    const data = JSON.parse(body);
    const status = data?.status ?? {};
    const agentPath = data?.agent_path ?? Object.keys(status)[0] ?? "";
    const completed =
      status?.completed ?? (agentPath ? status?.[agentPath]?.completed : "");
    return {
      agentPath,
      completed: typeof completed === "string" ? completed : "",
    };
  } catch {
    return null;
  }
}

function formatDurationMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function diffLineClass(line) {
  if (line.startsWith("+") && !line.startsWith("+++")) return "is-add";
  if (line.startsWith("-") && !line.startsWith("---")) return "is-remove";
  if (line.startsWith("@@")) return "is-hunk";
  if (
    line.startsWith("*** ") ||
    line.startsWith("diff ") ||
    line.startsWith("+++ ") ||
    line.startsWith("--- ")
  ) {
    return "is-meta";
  }
  return "";
}

function renderDiffText(text) {
  return String(text)
    .split("\n")
    .map((line) => {
      const cls = diffLineClass(line);
      const blankClass = line.trim() ? "" : "is-blank";
      const classes = [cls, blankClass].filter(Boolean).join(" ");
      const classAttr = classes ? ` class="${classes}"` : "";
      return `<span${classAttr}>${escapeHtml(line || " ")}</span>`;
    })
    .join("");
}

// GFM on; breaks off (soft newlines fold into paragraphs). Content is arbitrary
// transcript text, so every parse is run through DOMPurify before it reaches the
// DOM.
marked.setOptions({ gfm: true, breaks: false });

// Syntax-highlight fenced code blocks with highlight.js. hljs output is escaped
// span markup; sanitizeHtml() runs over it afterward (DOMPurify keeps classes).
marked.use({
  renderer: {
    code({ text, lang }) {
      let highlighted;
      let cls;
      try {
        if (lang && hljs.getLanguage(lang)) {
          highlighted = hljs.highlight(text, { language: lang }).value;
          cls = `hljs language-${lang}`;
        } else {
          const auto = hljs.highlightAuto(text);
          highlighted = auto.value;
          cls = auto.language ? `hljs language-${auto.language}` : "hljs";
        }
      } catch {
        highlighted = escapeHtml(text);
        cls = "hljs";
      }
      return `<pre><code class="${cls}">${highlighted}</code></pre>`;
    },
  },
});

// marked leaves links in-place; force new-tab + safe rel (after attr sanitize).
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

function sanitizeHtml(html) {
  return DOMPurify.sanitize(String(html), { USE_PROFILES: { html: true } });
}

function renderMarkdown(text) {
  try {
    return sanitizeHtml(marked.parse(String(text)));
  } catch {
    return escapeHtml(text);
  }
}

// Highlight raw code-segment text (tool input/result) when it is confirmed JSON.
// Returns null otherwise so plain stdout stays plain.
function highlightCode(text) {
  const trimmed = String(text).trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return hljs.highlight(String(text), { language: "json" }).value;
    } catch {
      /* not valid JSON — leave plain */
    }
  }
  return null;
}

// File extension → hljs language. Used to highlight Read results by their path.
const EXT_TO_LANG = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  md: "markdown",
  markdown: "markdown",
  sql: "sql",
  lua: "lua",
  r: "r",
  pl: "perl",
};

function langForPath(p) {
  if (typeof p !== "string") return null;
  const base = (p.split("/").pop() || "").toLowerCase();
  if (base === "dockerfile")
    return hljs.getLanguage("dockerfile") ? "dockerfile" : null;
  const ext = base.includes(".") ? base.split(".").pop() : "";
  const lang = EXT_TO_LANG[ext];
  return lang && hljs.getLanguage(lang) ? lang : null;
}

function commandResultOutput(text) {
  const output = String(text).match(/\nOutput:\n([\s\S]*)$/);
  if (!output) return String(text);
  return output[1].replace(/\n\^C$/, "");
}

// Render a line-numbered (cat -n) Read result as a gutter column of numbers
// beside one highlighted code block. Returns null when not line-numbered.
function renderFileResult(text, lang) {
  if (!lang || !hljs.getLanguage(lang)) return null;
  const body = commandResultOutput(text);
  const lines = body.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (!lines.length) return null;
  const nums = [];
  const code = [];
  let numbered = 0;
  for (const line of lines) {
    const tab = line.indexOf("\t");
    const head = tab >= 0 ? line.slice(0, tab) : "";
    if (tab >= 0 && /^\s*\d+$/.test(head)) {
      nums.push(head.trim());
      code.push(line.slice(tab + 1));
      numbered++;
    } else {
      nums.push("");
      code.push(line);
    }
  }
  if (numbered < lines.length * 0.6) {
    try {
      const highlighted = hljs.highlight(body, { language: lang }).value;
      return `<pre class="live-seg-code hljs">${highlighted}</pre>`;
    } catch {
      return null;
    }
  }
  let highlighted;
  try {
    highlighted = hljs.highlight(code.join("\n"), { language: lang }).value;
  } catch {
    return null;
  }
  return (
    '<div class="live-code">' +
    `<pre class="live-code-gutter" aria-hidden="true">${escapeHtml(nums.join("\n"))}</pre>` +
    `<pre class="live-code-body hljs">${highlighted}</pre>` +
    "</div>"
  );
}

// Flatten a tool-result/content value (string, array of blocks, or object) into
// displayable text for a code block.
function segText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) =>
        typeof part === "string"
          ? part
          : (part.text ?? part.content ?? JSON.stringify(part)),
      )
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") {
    return value.text ?? value.content ?? JSON.stringify(value, null, 2);
  }
  return String(value);
}

// Interleaved line diff: shared leading/trailing lines become context lines,
// only the changed middle gets -/+.
function unifiedLineDiff(oldText, newText) {
  const a = String(oldText ?? "").split("\n");
  const b = String(newText ?? "").split("\n");
  const maxLead = Math.min(a.length, b.length);
  let head = 0;
  while (head < maxLead && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < maxLead - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const out = [];
  for (let i = 0; i < head; i++) out.push(` ${a[i]}`);
  for (let i = head; i < a.length - tail; i++) out.push(`-${a[i]}`);
  for (let i = head; i < b.length - tail; i++) out.push(`+${b[i]}`);
  for (let i = a.length - tail; i < a.length; i++) out.push(` ${a[i]}`);
  return out;
}

// Edit / MultiEdit / Write → inline color-coded diff segment.
function claudeFileChangeSegment(part) {
  const name = part?.name;
  const input = part?.input;
  if (!input || typeof input !== "object") return null;
  const filePath = input.file_path ?? input.path ?? "";
  if (name === "Edit") {
    return {
      kind: "file-change",
      label: filePath ? `Edit · ${filePath}` : "Edit",
      filePath,
      diffText: [
        `--- ${filePath || "before"}`,
        `+++ ${filePath || "after"}`,
        "@@",
        ...unifiedLineDiff(input.old_string, input.new_string),
      ].join("\n"),
      toolUseId: part.id,
    };
  }
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const lines = [`--- ${filePath || "before"}`, `+++ ${filePath || "after"}`];
    for (const edit of input.edits) {
      lines.push("@@");
      lines.push(...unifiedLineDiff(edit.old_string, edit.new_string));
    }
    return {
      kind: "file-change",
      label: filePath ? `MultiEdit · ${filePath}` : "MultiEdit",
      filePath,
      diffText: lines.join("\n"),
      toolUseId: part.id,
    };
  }
  if (name === "Write") {
    return {
      kind: "file-change",
      label: filePath ? `Write · ${filePath}` : "Write",
      filePath,
      diffText: [
        "--- /dev/null",
        `+++ ${filePath || "new file"}`,
        "@@",
        ...String(input.content ?? "")
          .split("\n")
          .map((line) => `+${line}`),
      ].join("\n"),
      toolUseId: part.id,
    };
  }
  return null;
}

function resultSegment(part, lang) {
  return {
    kind: "code",
    label: part.is_error ? "⚠ result (error)" : "↳ result",
    error: !!part.is_error,
    text: segText(part.content),
    fileLang: part.is_error ? null : (lang ?? null),
  };
}

function contentSegments(content) {
  if (content == null) return [];
  if (typeof content === "string") {
    const task = parseTaskNotification(content);
    if (task) return [{ kind: "task-notification", task }];
    const subagent = parseSubagentNotification(content);
    if (subagent) return [{ kind: "subagent-notification", task: subagent }];
    return content.trim() ? [{ kind: "markdown", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    const text = content.text ?? content.content;
    if (typeof text === "string") {
      return text.trim() ? [{ kind: "markdown", text }] : [];
    }
    return [{ kind: "code", text: JSON.stringify(content, null, 2) }];
  }
  const out = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part.trim()) out.push({ kind: "markdown", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (
      (part.type === "text" ||
        part.type === "input_text" ||
        part.type === "output_text") &&
      part.text?.trim()
    ) {
      out.push({ kind: "markdown", text: part.text });
    } else if (part.type === "thinking" && part.thinking?.trim()) {
      out.push({
        kind: "markdown",
        text: part.thinking,
        label: "💭 thinking",
        note: true,
      });
    } else if (part.type === "tool_use") {
      const fileChange = claudeFileChangeSegment(part);
      if (fileChange) {
        out.push(fileChange);
        continue;
      }
      const input =
        typeof part.input === "string"
          ? part.input
          : JSON.stringify(part.input ?? {}, null, 2);
      out.push({
        kind: "code",
        label: `🔧 ${part.name ?? "tool"}`,
        text: input,
        toolUseId: part.id,
        resultLang:
          part.name === "Read" ? langForPath(part.input?.file_path) : null,
      });
    } else if (part.type === "tool_result") {
      out.push(resultSegment(part));
    } else if (part.type === "image") {
      out.push({ kind: "code", text: "[image]" });
    } else {
      const text = part.text ?? part.content;
      if (typeof text === "string") out.push({ kind: "markdown", text });
      else out.push({ kind: "code", text: JSON.stringify(part, null, 2) });
    }
  }
  return out;
}

function streamEntrySegments(entry) {
  const content = entry?.message?.content ?? entry?.content ?? entry?.text;
  const segs = contentSegments(content);
  if (segs.length) return segs;
  if (entry?.toolUseResult) {
    return [{ kind: "code", text: segText(entry.toolUseResult) }];
  }
  if (entry?.message?.usage) {
    return [
      { kind: "code", text: JSON.stringify(entry.message.usage, null, 2) },
    ];
  }
  return [{ kind: "code", text: JSON.stringify(entry, null, 2) }];
}

function renderStreamSegment(seg) {
  if (seg.kind === "task-notification") {
    const task = seg.task;
    const usage = [
      task.totalTokens ? `${fmtNum(Number(task.totalTokens))} tokens` : "",
      task.toolUses ? `${fmtNum(Number(task.toolUses))} tools` : "",
      formatDurationMs(task.durationMs),
    ].filter(Boolean);
    const result = task.result?.trim()
      ? `<div class="live-task-result">${renderMarkdown(task.result)}</div>`
      : "";
    const usageHtml = usage.length
      ? `<div class="live-task-meta">${usage
          .map((item) => `<span>${escapeHtml(item)}</span>`)
          .join("")}</div>`
      : "";
    return [
      '<section class="live-task-card">',
      `<div class="live-task-kicker">${escapeHtml(task.status)}</div>`,
      `<div class="live-task-title">${escapeHtml(task.summary)}</div>`,
      result,
      usageHtml,
      "</section>",
    ].join("");
  }
  if (seg.kind === "subagent-notification") {
    const task = seg.task;
    const result = task.completed
      ? `<pre class="live-subagent-result">${escapeHtml(task.completed)}</pre>`
      : "";
    return [
      '<section class="live-task-card live-subagent-card">',
      '<div class="live-task-kicker">completed</div>',
      '<div class="live-task-title">Subagent completed</div>',
      result,
      "</section>",
    ].join("");
  }
  if (seg.kind === "file-change") {
    const lineCount = seg.diffText ? seg.diffText.split("\n").length : 0;
    const summary = `${escapeHtml(seg.label)} · ${lineCount} lines`;
    const path = seg.filePath
      ? `<div class="live-file-path">${escapeHtml(seg.filePath)}</div>`
      : "";
    return [
      '<details class="live-seg live-file-change" open>',
      `<summary>${summary}</summary>`,
      path,
      `<pre class="live-diff">${renderDiffText(seg.diffText)}</pre>`,
      "</details>",
    ].join("");
  }
  if (seg.kind === "markdown") {
    const body = renderMarkdown(seg.text);
    if (!seg.label) return body;
    const cls = seg.note ? "live-seg live-seg--note" : "live-seg";
    return `<div class="${cls}"><div class="live-seg-label">${escapeHtml(seg.label)}</div>${body}</div>`;
  }
  const text = seg.text ?? "";
  const cls = seg.error ? "live-seg-code is-error" : "live-seg-code";
  const fileHtml = seg.fileLang ? renderFileResult(text, seg.fileLang) : null;
  let pre;
  if (fileHtml) {
    pre = fileHtml;
  } else {
    const highlighted = highlightCode(text);
    const preCls = highlighted ? `${cls} hljs` : cls;
    pre = `<pre class="${preCls}">${highlighted ?? escapeHtml(text)}</pre>`;
  }
  const lineCount = text ? text.split("\n").length : 0;
  if (seg.label || lineCount > STREAM_COLLAPSE_LINES) {
    const summary = `${escapeHtml(seg.label || "output")} · ${lineCount} lines`;
    return `<details class="live-seg"><summary>${summary}</summary>${pre}</details>`;
  }
  const label = seg.label
    ? `<div class="live-seg-label">${escapeHtml(seg.label)}</div>`
    : "";
  return `<div class="live-seg">${label}${pre}</div>`;
}

// Pre-render an entry to HTML once, on receipt. A tool_use renders with its
// paired result right below it once the result arrives.
function buildEntryHtml(entry) {
  const results = entry.__toolResults || {};
  const html = streamEntrySegments(entry)
    .map((seg) => {
      let segHtml = renderStreamSegment(seg);
      if (seg.toolUseId && results[seg.toolUseId]) {
        segHtml += renderStreamSegment(
          resultSegment(results[seg.toolUseId], seg.resultLang),
        );
      }
      return segHtml;
    })
    .join("");
  entry.__wide = /<(?:table|pre)[\s>]/.test(html);
  return html;
}

// The tool_result blocks of a pure tool-result entry (every block is a
// tool_result). Mixed entries (real user text + a result) are left alone.
function streamEntryToolResults(entry) {
  const content = entry?.message?.content;
  if (!Array.isArray(content) || !content.length) return [];
  const results = content.filter((b) => b && b.type === "tool_result");
  if (!results.length || results.length !== content.length) return [];
  return results;
}

function streamEntryHasToolSegments(entry) {
  const content = entry?.message?.content;
  return (
    Array.isArray(content) && content.some((b) => b && b.type === "tool_use")
  );
}

function streamEntryRole(entry) {
  if (streamEntryToolResults(entry).length) return "tool result";
  if (streamEntryHasToolSegments(entry)) return "tool";
  return entry.type || "unknown";
}

function liveEntryClass(entry) {
  const role = streamEntryRole(entry).replace(/\s+/g, "-");
  const toolClass = streamEntryHasToolSegments(entry)
    ? " has-tool-segments"
    : "";
  const wideClass = entry.__wide ? " has-wide-content" : "";
  return `live-entry is-${role}${toolClass}${wideClass}`;
}

export function initTranscript(rootEl) {
  if (!rootEl) return;

  let es = null;
  let keySeq = 0;
  let entries = [];
  const seen = Object.create(null); // dedupe reconnect resends by uuid
  let renderQueued = false;

  rootEl.classList.add("transcript");
  rootEl.innerHTML = `
    <div class="transcript__body"></div>
    <p class="transcript__empty placeholder">No live transcript.</p>`;
  const bodyEl = rootEl.querySelector(".transcript__body");
  const emptyEl = rootEl.querySelector(".transcript__empty");

  // rootEl (.column__body) is the scroll container — same as the decision-log
  // column. The inner __body just holds the entry stack.
  const isPinned = () =>
    rootEl.scrollHeight - rootEl.scrollTop - rootEl.clientHeight < 96;

  function reset() {
    keySeq = 0;
    entries = [];
    for (const k of Object.keys(seen)) delete seen[k];
    bodyEl.innerHTML = "";
    emptyEl.hidden = false;
  }

  // Stamp a stable key + dedupe on uuid (a reconnect resends the same uuids).
  // Positional fallback keeps id-less lines unique. Build HTML once here.
  function tagEntry(entry) {
    if (!entry || typeof entry !== "object") return null;
    const key = entry.uuid ?? `pos:${keySeq + 1}`;
    if (seen[key]) return null;
    seen[key] = true;
    entry.__key = ++keySeq;
    entry.__html = buildEntryHtml(entry);
    return entry;
  }

  // Merge each pure tool-result entry into the entry holding the matching
  // tool_use (by tool_use_id) so a call + its output render as one block; the
  // standalone result entry (a misleading "user" bubble) disappears.
  function reconcileToolResults() {
    const toolUseEntry = {};
    for (const e of entries) {
      const content = e?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b && b.type === "tool_use" && b.id) toolUseEntry[b.id] = e;
      }
    }
    const remove = new Set();
    for (const e of entries) {
      const results = streamEntryToolResults(e);
      if (!results.length) continue;
      if (!results.every((r) => toolUseEntry[r.tool_use_id])) continue;
      for (const r of results) {
        const target = toolUseEntry[r.tool_use_id];
        target.__toolResults = {
          ...(target.__toolResults || {}),
          [r.tool_use_id]: r,
        };
        target.__html = buildEntryHtml(target);
      }
      remove.add(e.__key);
    }
    if (remove.size) {
      entries = entries.filter((e) => !remove.has(e.__key));
    }
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      const pinned = isPinned();
      const prevTop = rootEl.scrollTop;
      bodyEl.innerHTML = entries
        .map(
          (e) =>
            `<div class="${liveEntryClass(e)}">` +
            `<div class="live-entry-role">${escapeHtml(streamEntryRole(e))}</div>` +
            `<div class="live-entry-content">${e.__html}</div>` +
            `</div>`,
        )
        .join("");
      emptyEl.hidden = entries.length > 0;
      if (pinned) rootEl.scrollTop = rootEl.scrollHeight;
      else rootEl.scrollTop = prevTop;
    });
  }

  function ingest(entry) {
    const tagged = tagEntry(entry);
    if (!tagged) return;
    entries.push(tagged);
    reconcileToolResults();
    scheduleRender();
  }

  function open(_project, session) {
    if (es) {
      es.close();
      es = null;
    }
    reset();
    if (!session) return;
    es = new EventSource(
      `/api/transcript/stream?session=${encodeURIComponent(session)}`,
    );
    es.onmessage = (e) => {
      if (!e.data) return;
      let entry;
      try {
        entry = JSON.parse(e.data);
      } catch {
        return; // skip unparseable frames
      }
      ingest(entry);
    };
    es.addEventListener("backlog-done", () => {
      rootEl.scrollTop = rootEl.scrollHeight;
    });
    es.onerror = () => {
      // EventSource auto-reconnects; uuid dedupe guards against backlog resends.
    };
  }

  store.subscribe((project, session) => open(project, session));
  open(store.selectedProject, store.selectedSessionId);
}
