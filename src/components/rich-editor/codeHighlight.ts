export interface CodeLanguageOption {
  id: string;
  label: string;
  aliases: string[];
  keywords: string[];
}

export interface CodeHighlightRange {
  from: number;
  to: number;
  className: string;
}

export const CODE_LANGUAGE_OPTIONS: CodeLanguageOption[] = [
  {
    id: "javascript",
    label: "JavaScript",
    aliases: ["js", "node"],
    keywords: commonKeywords([
      "const",
      "let",
      "var",
      "function",
      "return",
      "async",
      "await",
      "import",
      "export",
      "from",
      "class",
      "extends",
      "new",
      "this",
    ]),
  },
  {
    id: "typescript",
    label: "TypeScript",
    aliases: ["ts"],
    keywords: commonKeywords([
      "const",
      "let",
      "var",
      "function",
      "return",
      "async",
      "await",
      "import",
      "export",
      "from",
      "class",
      "extends",
      "interface",
      "type",
      "implements",
      "readonly",
      "public",
      "private",
    ]),
  },
  {
    id: "tsx",
    label: "TSX",
    aliases: ["typescriptreact"],
    keywords: commonKeywords(["const", "let", "return", "type", "interface", "props", "children"]),
  },
  {
    id: "jsx",
    label: "JSX",
    aliases: ["javascriptreact"],
    keywords: commonKeywords(["const", "let", "return", "props", "children", "className"]),
  },
  {
    id: "python",
    label: "Python",
    aliases: ["py"],
    keywords: commonKeywords([
      "def",
      "class",
      "return",
      "import",
      "from",
      "as",
      "async",
      "await",
      "with",
      "lambda",
      "self",
      "None",
      "True",
      "False",
    ]),
  },
  {
    id: "sql",
    label: "SQL",
    aliases: [],
    keywords: commonKeywords([
      "select",
      "from",
      "where",
      "join",
      "left",
      "right",
      "inner",
      "outer",
      "insert",
      "update",
      "delete",
      "create",
      "alter",
      "table",
      "group",
      "order",
      "by",
      "limit",
      "values",
    ]),
  },
  { id: "json", label: "JSON", aliases: [], keywords: [] },
  { id: "markdown", label: "Markdown", aliases: ["md"], keywords: [] },
  {
    id: "html",
    label: "HTML",
    aliases: ["xml"],
    keywords: commonKeywords(["html", "body", "div", "span", "section", "article", "script", "style"]),
  },
  {
    id: "css",
    label: "CSS",
    aliases: [],
    keywords: commonKeywords(["display", "position", "grid", "flex", "color", "background", "margin", "padding"]),
  },
  {
    id: "shell",
    label: "Shell",
    aliases: ["sh", "bash", "zsh"],
    keywords: commonKeywords(["if", "then", "else", "fi", "for", "do", "done", "case", "esac", "export"]),
  },
  {
    id: "rust",
    label: "Rust",
    aliases: ["rs"],
    keywords: commonKeywords(["fn", "let", "mut", "pub", "struct", "enum", "impl", "trait", "match", "use", "crate", "self"]),
  },
  {
    id: "go",
    label: "Go",
    aliases: ["golang"],
    keywords: commonKeywords(["func", "package", "import", "return", "defer", "go", "chan", "struct", "interface", "range"]),
  },
  {
    id: "java",
    label: "Java",
    aliases: [],
    keywords: commonKeywords(["class", "public", "private", "protected", "static", "final", "void", "new", "return", "extends"]),
  },
  {
    id: "c",
    label: "C",
    aliases: [],
    keywords: commonKeywords(["include", "define", "int", "char", "void", "return", "struct", "typedef", "const", "static"]),
  },
  {
    id: "cpp",
    label: "C++",
    aliases: ["c++", "cc", "cxx"],
    keywords: commonKeywords(["include", "namespace", "class", "public", "private", "template", "typename", "auto", "return"]),
  },
  { id: "yaml", label: "YAML", aliases: ["yml"], keywords: [] },
  { id: "toml", label: "TOML", aliases: [], keywords: [] },
];

const languageByAlias = new Map<string, CodeLanguageOption>();

for (const option of CODE_LANGUAGE_OPTIONS) {
  languageByAlias.set(option.id, option);
  option.aliases.forEach((alias) => languageByAlias.set(alias, option));
}

export function normalizeCodeLanguage(value?: string | null) {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9_+#.-]/g, "") ?? "";

  if (!normalized) {
    return "";
  }

  return languageByAlias.get(normalized)?.id ?? normalized;
}

export function codeLanguageLabel(language?: string | null) {
  const normalized = normalizeCodeLanguage(language);

  if (!normalized) {
    return "Plain Text";
  }

  return languageByAlias.get(normalized)?.label ?? normalized;
}

export function filterCodeLanguageOptions(query: string) {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return CODE_LANGUAGE_OPTIONS;
  }

  return CODE_LANGUAGE_OPTIONS.filter((option) =>
    [option.id, option.label, ...option.aliases].some((value) =>
      value.toLowerCase().includes(normalized),
    ),
  );
}

export function highlightCodeRanges(code: string, language?: string | null): CodeHighlightRange[] {
  const normalized = normalizeCodeLanguage(language);
  const ranges: CodeHighlightRange[] = [];

  collectRegexRanges(code, ranges, /(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, "rich-editor__code-token--string");
  collectRegexRanges(code, ranges, /(?:\/\/|#).*$/gm, "rich-editor__code-token--comment");
  collectRegexRanges(code, ranges, /\/\*[\s\S]*?\*\//g, "rich-editor__code-token--comment");
  collectRegexRanges(code, ranges, /\b\d+(?:\.\d+)?\b/g, "rich-editor__code-token--number");

  const option = languageByAlias.get(normalized);

  if (option?.keywords.length) {
    const keywordPattern = new RegExp(`\\b(?:${option.keywords.map(escapeRegExp).join("|")})\\b`, "gi");
    collectRegexRanges(code, ranges, keywordPattern, "rich-editor__code-token--keyword");
  }

  if (normalized === "html" || normalized === "tsx" || normalized === "jsx") {
    collectRegexRanges(code, ranges, /<\/?[a-z][\w:-]*/gi, "rich-editor__code-token--keyword");
  }

  return removeOverlappingRanges(ranges);
}

export function highlightCodeToHtml(code: string, language?: string | null) {
  const ranges = highlightCodeRanges(code, language);
  let html = "";
  let cursor = 0;

  ranges.forEach((range) => {
    html += escapeHtml(code.slice(cursor, range.from));
    html += `<span class="${range.className}">${escapeHtml(code.slice(range.from, range.to))}</span>`;
    cursor = range.to;
  });

  html += escapeHtml(code.slice(cursor));
  return html;
}

function commonKeywords(values: string[]) {
  return [
    ...values,
    "if",
    "else",
    "for",
    "while",
    "switch",
    "case",
    "break",
    "continue",
    "try",
    "catch",
    "throw",
    "true",
    "false",
    "null",
    "undefined",
  ];
}

function collectRegexRanges(
  code: string,
  ranges: CodeHighlightRange[],
  pattern: RegExp,
  className: string,
) {
  for (const match of code.matchAll(pattern)) {
    if (typeof match.index !== "number") {
      continue;
    }

    ranges.push({
      from: match.index,
      to: match.index + match[0].length,
      className,
    });
  }
}

function removeOverlappingRanges(ranges: CodeHighlightRange[]) {
  const sorted = ranges
    .filter((range) => range.to > range.from)
    .sort((left, right) => left.from - right.from || right.to - left.to);
  const result: CodeHighlightRange[] = [];
  let cursor = 0;

  sorted.forEach((range) => {
    if (range.from < cursor) {
      return;
    }

    result.push(range);
    cursor = range.to;
  });

  return result;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
