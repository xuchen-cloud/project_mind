const rules = [
  {
    rule: "absolute-markdown-link",
    pattern: /\]\(\s*<?(?:\/(?!\/)|file:\/\/|[A-Za-z]:[\\/]|\\\\)/u,
  },
  {
    rule: "unix-absolute-path",
    pattern: /(?<![:/A-Za-z0-9._<>~-])\/(?:Applications|Library|Network|System|Users|Volumes|bin|boot|cores|data|dev|etc|export|home|lib|lib32|lib64|libx32|lost\+found|media|mnt|nix|opt|platform|private|proc|rescue|root|rpool|run|sbin|sdcard|snap|srv|storage|sys|system|tmp|usr|var|vendor)(?=\/|[\s)`>]|$)(?:\/[^\s)`>]*)?/u,
  },
  {
    rule: "file-uri",
    pattern: /file:\/\/[^\s)`>]+/u,
  },
  {
    rule: "windows-drive-path",
    pattern: /(?:^|[\s('"`=])(?:[A-Za-z]:[\\/])[^\s)`>]*/u,
  },
  {
    rule: "unc-path",
    pattern: /(?:^|[\s('"`=])(?:(?:\\\\)[^\\\s]+\\|\/\/[^/\s]+\/)[^\s)`>]*/u,
  },
];

export function collectPortablePathViolations(file, source) {
  const violations = [];
  const lines = source.split("\n");

  for (const [index, line] of lines.entries()) {
    for (const { rule, pattern } of rules) {
      const match = line.match(pattern);
      if (!match) {
        continue;
      }
      violations.push({
        file,
        line: index + 1,
        rule,
        snippet: match[0].trim(),
      });
    }
  }

  return violations;
}
