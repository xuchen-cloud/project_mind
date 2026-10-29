//! Scoped, streaming grep over native Record and File reads (Issue #283).
use super::{
    cli_convenience, cli_encoding, parse_options, required_connection, scoped, CliBridge,
    CliOutput, Options,
};
use crate::agent::{
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, Scope, SourceRef, WorkspaceBinding},
};
use regex::{RegexSet, RegexSetBuilder};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    fs::File,
    io::{BufRead, BufReader, Read, Seek, Write},
    path::Path,
};

pub(super) const HELP: &str = r#"Usage: mind grep [OPTIONS] PATTERN [record:ID|file:ID ...]
       mind grep [OPTIONS] -e PATTERN|-f PATTERN_FILE ... [TARGET ...]

Search native Record Markdown and registered File text, line by line.
With no TARGET, read authorized Record and File inventories in the selected
scope (--project ID or --workspace-scope, also accepted from runtime environment).
For each kind, collect metadata references in a temporary file before reading
bodies, so lazy Record initialization cannot invalidate inventory cursors.
TARGET IDs come from record/file list; paths are not object IDs. Explicit targets
use the selected scope; the service validates their actual ownership.

Matching (case-sensitive by default):
  -G, --basic-regexp       Basic regex (default; \(group\), \{n,m\})
  -E, --extended-regexp    Extended regex ((group), +, ?, |, {n,m})
  -F, --fixed-strings      Literal patterns; recommended for Windows paths
  -e, --regexp PATTERN     Add a pattern; repeat for OR
  -f, --file PATTERN_FILE  Add one pattern per UTF-8/UTF-8-BOM file line; repeat
                          Use - once to read patterns from stdin
  -i, --ignore-case        Ignore letter case (Unicode)
  -v, --invert-match       Select nonmatching lines
  -x, --line-regexp        Match the entire line

Output:
  -n, --line-number        Show 1-based lines (Record lines are Markdown lines)
  -l, --files-with-matches Print matching object IDs, then skip remaining text
  -c, --count              Print matching line counts for each object
  -q, --quiet              Exit immediately on a match, without stdout
  -m, --max-count NUM      Stop after NUM selected lines in each object
  -A, --after-context NUM  Show NUM following lines
  -B, --before-context NUM Show NUM preceding lines
  -C, --context NUM        Show NUM surrounding lines
  -h, --no-filename        Omit object prefix (grep's -h; help is --help)
  -H, --with-filename      Include object prefix (default: record:ID:TEXT)

Common: --workspace PATH --connection ID --project ID | --workspace-scope
        --kind record|file (default: both) --request-id ID --help
Use -- to end options, --option=value, or attached short values (-Fin, -m2).
No shell expansion or backslash unescaping is performed by mind.
PowerShell: mind grep -Fn -e '\\?\D:\商店\[a] $x.txt'
For PowerShell 5.1 native quoting, use -F -f patterns.txt (UTF-8/BOM accepted).
Empty pattern lines match every line; an empty pattern file matches no lines.

Regex supports regular expressions, Unicode, and POSIX character classes.
Backreferences, lookaround, collating/equivalence classes and word-edge escapes
\< / \> and GNU buffer-edge escapes are unsupported and return a specific error.
\d means literal d, as
in grep; use [[:digit:]] for digits. No PCRE (-P) mode or locale collation.
Windows CRLF endings and a leading UTF-8 BOM are normalized before matching.
Limits: 2 MiB/32768 patterns, 1 MiB per text line; context <=10000 lines/8 MiB.
Each read pins its source revision. Changed/incomplete/unreadable sources report
diagnostics on stderr; earlier stdout may be partial. Office formats use the
available native extraction coverage, never an assumed complete search index.
Exit: 0 selected lines, 1 no selected lines, 2 error. Like grep, -q returns 0
as soon as it finds a match, even if an earlier source had a read error.
"#;

const MAX_PATTERN_BYTES: usize = 2 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 1024 * 1024;
const MAX_CONTEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_PAGES: usize = 65536;
type Sink<'a> = Option<&'a mut dyn FnMut(&str) -> AgentResult<()>>;

fn invalid(message: impl Into<String>) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn protocol(message: &str) -> AgentError {
    AgentError::new(
        ErrorCode::IoFailed,
        format!("Invalid grep read response: {message}; earlier output may be partial"),
    )
}
fn budget(message: &str) -> AgentError {
    AgentError::new(ErrorCode::BudgetExceeded, message)
}
fn snapshot_error(error: std::io::Error) -> AgentError {
    AgentError::new(
        ErrorCode::IoFailed,
        format!("Cannot access grep inventory snapshot: {error}"),
    )
}
#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Syntax {
    #[default]
    Basic,
    Extended,
    Fixed,
}
#[derive(Default)]
struct Grep {
    syntax: Syntax,
    patterns: Vec<String>,
    pattern_bytes: usize,
    ignore_case: bool,
    invert: bool,
    entire: bool,
    numbers: bool,
    list: bool,
    count: bool,
    quiet: bool,
    max_count: Option<usize>,
    before: usize,
    after: usize,
    no_filename: bool,
    kind: Option<ObjectKind>,
    targets: Vec<String>,
}

fn value(
    args: &[String],
    index: &mut usize,
    attached: Option<&str>,
    name: &str,
) -> AgentResult<String> {
    if let Some(value) = attached {
        return Ok(value.to_owned());
    }
    *index += 1;
    args.get(*index)
        .cloned()
        .ok_or_else(|| invalid(format!("Missing value for {name}")))
}
fn number(raw: &str, flag: &str) -> AgentResult<usize> {
    if raw.is_empty() || !raw.bytes().all(|ch| ch.is_ascii_digit()) {
        return Err(invalid(format!("{flag} requires a nonnegative integer")));
    }
    raw.parse()
        .map_err(|_| invalid(format!("{flag} is too large")))
}
fn add_patterns(grep: &mut Grep, raw: &str) -> AgentResult<()> {
    if grep.pattern_bytes.saturating_add(raw.len()) > MAX_PATTERN_BYTES {
        return Err(budget("grep patterns exceed 2 MiB"));
    }
    grep.pattern_bytes += raw.len();
    // A final newline separates patterns; it does not add a further empty pattern.
    // Unlike lines(), split_terminator preserves an explicit empty pattern.
    if raw.is_empty() {
        grep.patterns.push(String::new());
    } else {
        grep.patterns
            .extend(raw.split_terminator('\n').map(str::to_owned));
    }
    if grep.patterns.len() > 32768 {
        return Err(budget("grep exceeds 32768 patterns"));
    }
    Ok(())
}
fn pattern_file(grep: &mut Grep, path: &str, stdin_used: &mut bool) -> AgentResult<()> {
    let input: Box<dyn Read> = if path == "-" {
        if *stdin_used {
            return Err(invalid("stdin may be used by only one -f/--file"));
        }
        *stdin_used = true;
        Box::new(std::io::stdin())
    } else {
        Box::new(std::fs::File::open(path).map_err(|error| {
            AgentError::new(
                ErrorCode::IoFailed,
                format!("Cannot read pattern file {path:?}: {error}"),
            )
        })?)
    };
    let mut bytes = vec![];
    input
        .take(MAX_PATTERN_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            AgentError::new(
                ErrorCode::IoFailed,
                format!("Cannot read pattern file {path:?}: {error}"),
            )
        })?;
    if bytes.len() > MAX_PATTERN_BYTES {
        return Err(budget("grep pattern file exceeds 2 MiB"));
    }
    let text = cli_encoding::decode_utf8(&bytes)
        .map_err(|error| invalid(format!("Pattern file {path:?}: {}", error.message)))?;
    if !text.is_empty() {
        for line in text.split_terminator('\n') {
            add_patterns(grep, line.strip_suffix('\r').unwrap_or(line))?;
        }
    }
    Ok(())
}

fn parse(args: &[String]) -> AgentResult<(Grep, Options)> {
    let mut grep = Grep::default();
    let mut common = vec![];
    let mut positional = vec![];
    let mut index = 0;
    let mut end_options = false;
    let mut explicit_patterns = false;
    let mut stdin_used = false;
    let mut syntax = None;
    while index < args.len() {
        let raw = &args[index];
        if end_options || !raw.starts_with('-') || raw == "-" {
            positional.push(raw.clone());
            index += 1;
            continue;
        }
        if raw == "--" {
            end_options = true;
            index += 1;
            continue;
        }
        let (flag, attached) = raw
            .split_once('=')
            .map_or((raw.as_str(), None), |(flag, value)| (flag, Some(value)));
        if flag.starts_with("--") {
            if matches!(
                flag,
                "--workspace" | "--connection" | "--project" | "--request-id"
            ) {
                let value = value(args, &mut index, attached, flag)?;
                common.push(format!("{flag}={value}"));
                index += 1;
                continue;
            }
            if matches!(flag, "--workspace-scope" | "--help") {
                if attached.is_some() {
                    return Err(invalid(format!("{flag} does not take a value")));
                }
                common.push(flag.to_owned());
                index += 1;
                continue;
            }
            let short = match flag {
                "--basic-regexp" => 'G',
                "--extended-regexp" => 'E',
                "--fixed-strings" => 'F',
                "--ignore-case" => 'i',
                "--invert-match" => 'v',
                "--line-regexp" => 'x',
                "--line-number" => 'n',
                "--files-with-matches" => 'l',
                "--count" => 'c',
                "--quiet" | "--silent" => 'q',
                "--max-count" => 'm',
                "--after-context" => 'A',
                "--before-context" => 'B',
                "--context" => 'C',
                "--regexp" => 'e',
                "--file" => 'f',
                "--no-filename" => 'h',
                "--with-filename" => 'H',
                "--kind" => 'k',
                _ => {
                    return Err(invalid(format!(
                        "Unknown grep option: {flag}; use mind grep --help"
                    )))
                }
            };
            let takes_value = matches!(short, 'e' | 'f' | 'm' | 'A' | 'B' | 'C' | 'k');
            if !takes_value && attached.is_some() {
                return Err(invalid(format!("{flag} does not take a value")));
            }
            let raw_value = if takes_value {
                Some(value(args, &mut index, attached, flag)?)
            } else {
                None
            };
            apply(
                &mut grep,
                short,
                raw_value.as_deref(),
                &mut explicit_patterns,
                &mut stdin_used,
                &mut syntax,
            )?;
        } else {
            let mut flags = raw[1..].char_indices().peekable();
            while let Some((at, flag)) = flags.next() {
                let takes_value = matches!(flag, 'e' | 'f' | 'm' | 'A' | 'B' | 'C');
                let raw_value = if takes_value {
                    let start = 1 + at + flag.len_utf8();
                    let attached = (start < raw.len()).then(|| &raw[start..]);
                    Some(value(args, &mut index, attached, &format!("-{flag}"))?)
                } else {
                    None
                };
                apply(
                    &mut grep,
                    flag,
                    raw_value.as_deref(),
                    &mut explicit_patterns,
                    &mut stdin_used,
                    &mut syntax,
                )?;
                if takes_value {
                    break;
                }
            }
        }
        index += 1;
    }
    let mut options = parse_options(&common)?;
    if !options.help {
        if !explicit_patterns {
            if positional.is_empty() {
                return Err(invalid(
                    "grep requires PATTERN or -e/-f; use mind grep --help",
                ));
            }
            add_patterns(&mut grep, &positional.remove(0))?;
        }
        grep.targets = positional;
        cli_convenience::environment(&mut options, "grep", |key| std::env::var(key).ok())?;
    }
    Ok((grep, options))
}

fn apply(
    grep: &mut Grep,
    flag: char,
    raw: Option<&str>,
    explicit: &mut bool,
    stdin_used: &mut bool,
    syntax: &mut Option<Syntax>,
) -> AgentResult<()> {
    match flag {
        'G' | 'E' | 'F' => {
            let selected = match flag {
                'G' => Syntax::Basic,
                'E' => Syntax::Extended,
                _ => Syntax::Fixed,
            };
            if syntax.is_some_and(|old| old != selected) {
                return Err(invalid("Conflicting grep matchers: choose -G, -E or -F"));
            }
            *syntax = Some(selected);
            grep.syntax = selected;
        }
        'i' => grep.ignore_case = true,
        'v' => grep.invert = true,
        'x' => grep.entire = true,
        'n' => grep.numbers = true,
        'l' => grep.list = true,
        'c' => grep.count = true,
        'q' => grep.quiet = true,
        'h' => grep.no_filename = true,
        'H' => grep.no_filename = false,
        'e' => {
            *explicit = true;
            add_patterns(grep, raw.expect("value option"))?;
        }
        'f' => {
            *explicit = true;
            pattern_file(grep, raw.expect("value option"), stdin_used)?;
        }
        'm' => grep.max_count = Some(number(raw.expect("value option"), "--max-count")?),
        'A' | 'B' | 'C' => {
            let amount = number(raw.expect("value option"), "--context")?;
            if amount > 10000 {
                return Err(budget("grep context exceeds 10000 lines"));
            }
            match flag {
                'A' => grep.after = amount,
                'B' => grep.before = amount,
                _ => {
                    grep.before = amount;
                    grep.after = amount;
                }
            }
        }
        'k' => {
            let kind = match raw {
                Some("record") => ObjectKind::Record,
                Some("file") => ObjectKind::File,
                _ => return Err(invalid("--kind must be record or file")),
            };
            if grep.kind.is_some() {
                return Err(invalid("Duplicate --kind"));
            }
            grep.kind = Some(kind);
        }
        _ => {
            return Err(invalid(format!(
                "Unknown grep option: -{flag}; use mind grep --help"
            )))
        }
    }
    Ok(())
}

/// Convert grep's BRE/ERE spelling rather than allowing Rust-only escapes to
/// silently acquire a different meaning (notably \d and inline (?flags)).
fn regular(pattern: &str, syntax: Syntax) -> AgentResult<String> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let mut branch_start = true;
    let mut star_literal = true;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '[' {
            out.push('[');
            i += 1;
            if chars.get(i) == Some(&'^') {
                out.push('^');
                i += 1;
            }
            if chars.get(i) == Some(&']') {
                out.push_str(r"\]");
                i += 1;
            }
            let mut closed = false;
            while i < chars.len() {
                let current = chars[i];
                if current == ']' {
                    out.push(']');
                    i += 1;
                    closed = true;
                    break;
                }
                if current == '[' && matches!(chars.get(i + 1), Some('.' | '=')) {
                    return Err(invalid(
                        "grep collating/equivalence classes are unsupported; use -F for literals",
                    ));
                }
                if current == '[' && chars.get(i + 1) == Some(&':') {
                    let start = i;
                    i += 2;
                    while i + 1 < chars.len() && !(chars[i] == ':' && chars[i + 1] == ']') {
                        i += 1;
                    }
                    if i + 1 >= chars.len() {
                        return Err(invalid("Unclosed POSIX character class"));
                    }
                    i += 2;
                    out.extend(chars[start..i].iter());
                    continue;
                }
                // grep bracket expressions have literal backslashes and do not
                // have Rust's nested classes, intersections or differences.
                if matches!(current, '\\' | '[' | '&' | '~') {
                    out.push('\\');
                }
                // Two adjacent hyphens can mean a Rust set subtraction; escape
                // only a repeated hyphen (ordinary a-z remains a range).
                if current == '-' && chars.get(i + 1) == Some(&'-') {
                    return Err(invalid("Ambiguous '--' bracket range is unsupported; use separate alternatives or -F"));
                }
                out.push(current);
                i += 1;
            }
            if !closed {
                return Err(invalid("Unclosed grep bracket expression"));
            }
            branch_start = false;
            star_literal = false;
            continue;
        }
        if ch == '\\' {
            i += 1;
            let escaped = *chars.get(i).ok_or_else(|| {
                invalid("Trailing backslash in grep pattern; use -F for a literal Windows path")
            })?;
            if escaped.is_ascii_digit() && escaped != '0' {
                return Err(invalid("grep backreferences (\\1 ... \\9) are unsupported; use -F for literal backslashes"));
            }
            if matches!(escaped, '<' | '>') {
                return Err(invalid(
                    "grep word-edge escapes \\< and \\> are unsupported; use \\b where applicable",
                ));
            }
            if matches!(escaped, '`' | '\'') {
                return Err(invalid("GNU grep buffer-edge escapes are unsupported; use ^ and $ for line edges, or -F for literals"));
            }
            if matches!(escaped, 'b' | 'B' | 'w' | 'W' | 's' | 'S') {
                out.push('\\');
                out.push(escaped);
                branch_start = false;
                star_literal = false;
            } else if syntax == Syntax::Basic
                && matches!(escaped, '(' | ')' | '{' | '}' | '+' | '?' | '|')
            {
                out.push(escaped);
                branch_start = matches!(escaped, '(' | '|');
                star_literal = branch_start;
            } else {
                out.push_str(&regex::escape(&escaped.to_string()));
                branch_start = false;
                star_literal = false;
            }
            i += 1;
            continue;
        }
        if syntax == Syntax::Basic && matches!(ch, '(' | ')' | '{' | '}' | '+' | '?' | '|') {
            out.push_str(&regex::escape(&ch.to_string()));
            branch_start = false;
            star_literal = false;
            i += 1;
            continue;
        }
        if syntax == Syntax::Extended && ch == '(' && chars.get(i + 1) == Some(&'?') {
            return Err(invalid(
                "grep ERE does not support '(?' groups, inline flags or lookaround",
            ));
        }
        if syntax == Syntax::Basic && ch == '^' && !branch_start {
            out.push_str(r"\^");
        } else if syntax == Syntax::Basic
            && ch == '$'
            && i + 1 < chars.len()
            && !(chars[i + 1] == '\\' && matches!(chars.get(i + 2), Some(')' | '|')))
        {
            out.push_str(r"\$");
        } else if ch == '*' && star_literal {
            out.push_str(r"\*");
        } else {
            out.push(ch);
        }
        star_literal =
            (ch == '^' && branch_start) || (syntax == Syntax::Extended && matches!(ch, '(' | '|'));
        branch_start = syntax == Syntax::Extended && matches!(ch, '(' | '|');
        i += 1;
    }
    Ok(out)
}

struct Matcher(RegexSet);
impl Matcher {
    fn new(grep: &Grep) -> AgentResult<Self> {
        let mut patterns = Vec::with_capacity(grep.patterns.len());
        for pattern in &grep.patterns {
            let pattern = if grep.syntax == Syntax::Fixed {
                regex::escape(pattern)
            } else {
                regular(pattern, grep.syntax)?
            };
            let pattern = if grep.entire {
                format!("\\A(?:{pattern})\\z")
            } else {
                pattern
            };
            patterns.push(pattern);
        }
        let compiled = RegexSetBuilder::new(patterns)
            .case_insensitive(grep.ignore_case)
            .size_limit(16 * 1024 * 1024)
            .build()
            .map_err(|error| invalid(format!("Invalid grep pattern: {error}")))?;
        Ok(Self(compiled))
    }
    fn selected(&self, line: &str, grep: &Grep) -> bool {
        self.0.is_match(line) != grep.invert
    }
}

struct Output<'a> {
    sink: Sink<'a>,
    stdout: String,
    stderr: String,
    matched: bool,
    failed: bool,
    sink_failed: bool,
}
impl Output<'_> {
    fn emit(&mut self, text: &str) -> AgentResult<()> {
        if let Some(sink) = self.sink.as_mut() {
            if let Err(error) = sink(text) {
                self.sink_failed = true;
                return Err(error);
            }
        } else {
            self.stdout.push_str(text);
        }
        Ok(())
    }
    fn error(&mut self, label: &str, error: AgentError) {
        self.failed = true;
        let code = serde_json::to_value(error.code).expect("error code");
        self.stderr.push_str(&format!(
            "mind grep: {label}: {}: {}\n",
            code.as_str().expect("code string"),
            error.message
        ));
        if let Some(details) = error.details {
            self.stderr.push_str(&format!("  {details}\n"));
        }
    }
    fn finish(self, quiet: bool) -> CliOutput {
        let exit_code = if quiet && self.matched && !self.sink_failed {
            0
        } else if self.failed {
            2
        } else if self.matched {
            0
        } else {
            1
        };
        CliOutput {
            stdout: self.stdout,
            stderr: self.stderr,
            exit_code,
        }
    }
}

struct Lines<'a> {
    grep: &'a Grep,
    matcher: &'a Matcher,
    label: String,
    pending: String,
    number: usize,
    selected: usize,
    trailing: usize,
    previous: VecDeque<(usize, String)>,
    previous_bytes: usize,
    last_printed: usize,
}
impl<'a> Lines<'a> {
    fn new(grep: &'a Grep, matcher: &'a Matcher, label: String) -> Self {
        Self {
            grep,
            matcher,
            label,
            pending: String::new(),
            number: 0,
            selected: 0,
            trailing: 0,
            previous: VecDeque::new(),
            previous_bytes: 0,
            last_printed: 0,
        }
    }
    fn printed(
        &mut self,
        number: usize,
        text: &str,
        selected: bool,
        output: &mut Output<'_>,
    ) -> AgentResult<()> {
        if number <= self.last_printed {
            return Ok(());
        }
        if self.last_printed > 0
            && number > self.last_printed + 1
            && (self.grep.before > 0 || self.grep.after > 0)
        {
            output.emit("--\n")?;
        }
        let separator = if selected { ':' } else { '-' };
        let mut line = String::new();
        if !self.grep.no_filename {
            line.push_str(&self.label);
            line.push(separator);
        }
        if self.grep.numbers {
            line.push_str(&number.to_string());
            line.push(separator);
        }
        line.push_str(text);
        line.push('\n');
        output.emit(&line)?;
        self.last_printed = number;
        Ok(())
    }
    /// True means the current object needs no more text (-q/-l/-m).
    fn line(&mut self, mut line: String, output: &mut Output<'_>) -> AgentResult<bool> {
        if self.number == 0 && line.starts_with('\u{feff}') {
            line.drain(..'\u{feff}'.len_utf8());
        }
        if line.ends_with('\r') {
            line.pop();
        }
        self.number += 1;
        let capped = self
            .grep
            .max_count
            .is_some_and(|limit| self.selected >= limit);
        let selected = !capped && self.matcher.selected(&line, self.grep);
        if selected {
            self.selected += 1;
            output.matched = true;
            if self.grep.quiet {
                return Ok(true);
            }
            if self.grep.list {
                output.emit(&format!("{}\n", self.label))?;
                return Ok(true);
            }
        }
        if !self.grep.count && !self.grep.quiet && !self.grep.list {
            if selected {
                while let Some((number, text)) = self.previous.pop_front() {
                    self.printed(number, &text, false, output)?;
                }
                self.previous_bytes = 0;
                self.printed(self.number, &line, true, output)?;
                self.trailing = self.grep.after;
            } else if self.trailing > 0 {
                self.printed(self.number, &line, false, output)?;
                self.trailing -= 1;
            }
            if self.grep.before > 0 {
                self.previous_bytes += line.len();
                self.previous.push_back((self.number, line));
                while self.previous.len() > self.grep.before {
                    self.previous_bytes -= self.previous.pop_front().expect("previous").1.len();
                }
                if self.previous_bytes > MAX_CONTEXT_BYTES {
                    return Err(budget("grep preceding context exceeds 8 MiB; reduce -B/-C"));
                }
            }
        }
        Ok(self
            .grep
            .max_count
            .is_some_and(|limit| self.selected >= limit)
            && (self.grep.count || self.trailing == 0))
    }
    fn text(&mut self, text: &str, finished: bool, output: &mut Output<'_>) -> AgentResult<bool> {
        for part in text.split_inclusive('\n') {
            let newline = part.ends_with('\n');
            let content = part.strip_suffix('\n').unwrap_or(part);
            if self.pending.len().saturating_add(content.len()) > MAX_LINE_BYTES {
                return Err(budget(
                    "grep line exceeds 1 MiB; no line was truncated; earlier output may be partial",
                ));
            }
            self.pending.push_str(content);
            if newline {
                let line = std::mem::take(&mut self.pending);
                if self.line(line, output)? {
                    return Ok(true);
                }
            }
        }
        if finished && !self.pending.is_empty() {
            let line = std::mem::take(&mut self.pending);
            return self.line(line, output);
        }
        Ok(false)
    }
    fn finish(&self, output: &mut Output<'_>) -> AgentResult<()> {
        if self.grep.count && !self.grep.quiet && !self.grep.list {
            output.emit(&format!(
                "{}{}\n",
                if self.grep.no_filename {
                    String::new()
                } else {
                    format!("{}:", self.label)
                },
                self.selected
            ))?;
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    source_ref: SourceRef,
    text: String,
    next_cursor: Option<String>,
    complete: bool,
    #[serde(default)]
    range_complete: bool,
    head_revision: Option<u64>,
    extraction: Option<Value>,
}

struct Session<'a, B> {
    bridge: &'a mut B,
    workspace: &'a Path,
    connection: &'a str,
    request_id: String,
    binding: WorkspaceBinding,
    scope: Scope,
}
impl<B: CliBridge> Session<'_, B> {
    fn call(&mut self, method: &str, params: Value) -> AgentResult<Value> {
        self.bridge.call(
            self.workspace,
            self.connection,
            method,
            params,
            &self.request_id,
        )
    }
    fn read(
        &mut self,
        object: &ObjectRef,
        grep: &Grep,
        matcher: &Matcher,
        output: &mut Output<'_>,
    ) -> AgentResult<()> {
        let kind = if object.kind == ObjectKind::Record {
            "record"
        } else {
            "file"
        };
        let mut lines = Lines::new(grep, matcher, format!("{kind}:{}", object.id));
        if grep.max_count == Some(0) || (grep.patterns.is_empty() && !grep.invert) {
            return lines.finish(output);
        }
        let mut params = if object.kind == ObjectKind::Record {
            json!({"object":object,"format":"markdown","budgetChars":12000})
        } else {
            json!({"source":{"object":object},"view":"full","budgetChars":12000})
        };
        let method = if object.kind == ObjectKind::Record {
            "record.get"
        } else {
            "source.read"
        };
        let mut fingerprint = None;
        let mut head = None;
        let mut previous_cursor = None;
        let mut coverage_reported = false;
        for _ in 0..MAX_PAGES {
            let page: Page = serde_json::from_value(self.call(method, params.clone())?)
                .map_err(|_| protocol("missing page fields"))?;
            if page.source_ref.object != *object || page.source_ref.revision.is_empty() {
                return Err(protocol("object identity mismatch"));
            }
            let observed = (
                page.source_ref.revision.clone(),
                page.source_ref.file_version,
                page.source_ref.record_version,
            );
            if fingerprint.as_ref().is_some_and(|old| old != &observed)
                || (fingerprint.is_some() && head != page.head_revision)
            {
                return Err(AgentError::new(
                    ErrorCode::SourceChanged,
                    "Source revision changed during grep; earlier output is partial",
                ));
            }
            if object.kind == ObjectKind::Record && page.head_revision.is_none() {
                return Err(protocol("missing Record head revision"));
            }
            let incomplete = page
                .extraction
                .as_ref()
                .is_some_and(|extraction| extraction["coverage"]["complete"] != true);
            if let Some(extraction) = &page.extraction {
                if incomplete && !coverage_reported {
                    coverage_reported = true;
                    output.error(&lines.label,AgentError::new(ErrorCode::SourceNotReady,format!("Incomplete File extraction: {} (state: {}); grep cannot establish absence in unread content",extraction["reason"].as_str().unwrap_or("coverage incomplete"),extraction["state"].as_str().unwrap_or("unknown"))));
                }
            }
            // A partial extraction may exhaust its available projection while
            // neither complete flag is true. Show that text, preserving the
            // coverage error, instead of mistaking it for a bad cursor.
            let finished =
                page.next_cursor.is_none() && (page.complete || page.range_complete || incomplete);
            if !finished
                && (page.complete
                    || page.text.is_empty()
                    || page.next_cursor.as_ref().is_none_or(|cursor| {
                        cursor.is_empty()
                            || cursor.len() > 2048
                            || Some(cursor) == previous_cursor.as_ref()
                    }))
            {
                return Err(protocol("invalid continuation"));
            }
            fingerprint = Some(observed);
            head = page.head_revision;
            if lines.text(&page.text, finished, output)? || finished {
                return lines.finish(output);
            }
            if object.kind == ObjectKind::Record {
                params["revision"] = json!(page.source_ref.revision);
            } else {
                params["source"]["revision"] = json!(page.source_ref.revision);
                // The native cursor binds the original selection, including
                // whether fileVersion was specified. Pin revision without
                // changing that selection; observed versions are checked above.
            }
            params["cursor"] = json!(page.next_cursor);
            previous_cursor = page.next_cursor;
        }
        Err(budget(
            "grep exceeds 65536 read pages for one object; earlier output is partial",
        ))
    }
    fn inventory(
        &mut self,
        kind: ObjectKind,
        grep: &Grep,
        matcher: &Matcher,
        output: &mut Output<'_>,
    ) -> AgentResult<()> {
        let mut snapshot = self.inventory_snapshot(kind, output)?;
        snapshot.rewind().map_err(snapshot_error)?;
        for encoded in BufReader::new(snapshot).lines() {
            let encoded = encoded.map_err(snapshot_error)?;
            // References were validated before this private, process-owned
            // spool was written. Every body read still authorizes current
            // ownership, visibility and source revision in the native service.
            let object: ObjectRef = serde_json::from_str(&encoded).map_err(|error| {
                AgentError::new(
                    ErrorCode::IoFailed,
                    format!("Cannot read grep inventory snapshot: {error}"),
                )
            })?;
            if let Err(error) = self.read(&object, grep, matcher, output) {
                output.error(
                    &format!(
                        "{}:{}",
                        if kind == ObjectKind::Record {
                            "record"
                        } else {
                            "file"
                        },
                        object.id
                    ),
                    error,
                );
                if output.sink_failed {
                    return Ok(());
                }
            }
            if grep.quiet && output.matched {
                return Ok(());
            }
        }
        Ok(())
    }
    fn inventory_snapshot(
        &mut self,
        kind: ObjectKind,
        output: &mut Output<'_>,
    ) -> AgentResult<File> {
        // record.get may initialize a legacy canonical head, and file reads may
        // persist extraction metadata. Both inventory cursors pin DB changes;
        // finish their metadata pass before allowing those writes. This spool
        // bounds memory without retaining any corpus text or scanning a disk.
        let mut snapshot = tempfile::tempfile().map_err(snapshot_error)?;
        let method = if kind == ObjectKind::Record {
            "record.list"
        } else {
            "file.list"
        };
        let mut params =
            json!({"scope":self.scope,"mode":"metadata","limit":50,"budgetChars":12000});
        let mut previous_cursor = None;
        for _ in 0..MAX_PAGES {
            let page = self.call(method, params.clone())?;
            if page.get("countComplete") == Some(&json!(false))
                || page["unreadableCount"].as_u64().unwrap_or(0) > 0
            {
                output.error(
                    method,
                    AgentError::new(
                        ErrorCode::SourceNotReady,
                        "Inventory has unreadable entries; grep coverage is incomplete",
                    ),
                );
            }
            let items = page["items"]
                .as_array()
                .ok_or_else(|| protocol("inventory items missing"))?;
            for item in items {
                let object: ObjectRef = serde_json::from_value(item["object"].clone())
                    .map_err(|_| protocol("inventory object missing"))?;
                if object.workspace_id != self.binding.workspace_id
                    || object.scope != self.scope
                    || object.kind != kind
                {
                    return Err(protocol("inventory object ownership mismatch"));
                }
                object.key()?;
                serde_json::to_writer(&mut snapshot, &object).map_err(|error| {
                    AgentError::new(
                        ErrorCode::IoFailed,
                        format!("Cannot write grep inventory snapshot: {error}"),
                    )
                })?;
                snapshot.write_all(b"\n").map_err(snapshot_error)?;
            }
            let more = page["hasMore"]
                .as_bool()
                .ok_or_else(|| protocol("inventory hasMore missing"))?;
            if !more {
                return Ok(snapshot);
            }
            let cursor = page["nextCursor"]
                .as_str()
                .filter(|cursor| !cursor.is_empty() && cursor.len() <= 2048)
                .ok_or_else(|| protocol("inventory cursor missing"))?;
            if previous_cursor.as_deref() == Some(cursor) || items.is_empty() {
                return Err(protocol("inventory made no progress"));
            }
            previous_cursor = Some(cursor.to_owned());
            params["cursor"] = json!(cursor);
        }
        Err(budget(
            "grep exceeds 65536 inventory pages; earlier output is partial",
        ))
    }
}

fn target(
    raw: &str,
    binding: &WorkspaceBinding,
    scope: &Scope,
    kind: Option<ObjectKind>,
) -> AgentResult<ObjectRef> {
    let (prefix, id) = raw.split_once(':').ok_or_else(|| {
        invalid("grep TARGET must be record:ID or file:ID (obtain IDs from list)")
    })?;
    let actual = match prefix {
        "record" => ObjectKind::Record,
        "file" => ObjectKind::File,
        _ => return Err(invalid("grep TARGET must be record:ID or file:ID")),
    };
    if kind.is_some_and(|kind| kind != actual) {
        return Err(invalid("grep TARGET conflicts with --kind"));
    }
    if id
        .parse::<i64>()
        .ok()
        .is_none_or(|number| number <= 0 || number.to_string() != id)
    {
        return Err(invalid("grep TARGET needs a positive native ID"));
    }
    let object = ObjectRef {
        workspace_id: binding.workspace_id.clone(),
        scope: scope.clone(),
        kind: actual,
        id: id.into(),
    };
    object.key()?;
    Ok(object)
}

pub(super) fn run(args: &[String], bridge: &mut impl CliBridge, sink: Sink<'_>) -> CliOutput {
    let mut output = Output {
        sink,
        stdout: String::new(),
        stderr: String::new(),
        matched: false,
        failed: false,
        sink_failed: false,
    };
    let (grep, options) = match parse(args) {
        Ok(parsed) => parsed,
        Err(error) => {
            output.error("arguments", error);
            return output.finish(false);
        }
    };
    if options.help {
        return CliOutput {
            stdout: HELP.into(),
            stderr: String::new(),
            exit_code: 0,
        };
    }
    let setup = (|| -> AgentResult<_> {
        let matcher = Matcher::new(&grep)?;
        let scope = scoped(&options)?;
        let (workspace, connection) = required_connection(&options)?;
        let request_id = options.request_id.clone().unwrap_or_else(super::request_id);
        let binding = bridge.binding(workspace, connection, &request_id)?;
        let objects = grep
            .targets
            .iter()
            .map(|raw| target(raw, &binding, &scope, grep.kind))
            .collect::<AgentResult<Vec<_>>>()?;
        Ok((
            matcher, workspace, connection, request_id, binding, scope, objects,
        ))
    })();
    let (matcher, workspace, connection, request_id, binding, scope, objects) = match setup {
        Ok(setup) => setup,
        Err(error) => {
            output.error("arguments/binding", error);
            return output.finish(false);
        }
    };
    if grep.max_count == Some(0) && (grep.quiet || !grep.count) {
        return output.finish(grep.quiet);
    }
    let mut session = Session {
        bridge,
        workspace,
        connection,
        request_id,
        binding,
        scope,
    };
    if objects.is_empty() {
        for kind in [ObjectKind::Record, ObjectKind::File] {
            if grep.kind.is_some_and(|selected| selected != kind) {
                continue;
            }
            if let Err(error) = session.inventory(kind, &grep, &matcher, &mut output) {
                output.error("inventory", error);
            }
            if output.sink_failed || (grep.quiet && output.matched) {
                break;
            }
        }
    } else {
        for object in objects {
            if let Err(error) = session.read(&object, &grep, &matcher, &mut output) {
                output.error(
                    &format!(
                        "{}:{}",
                        if object.kind == ObjectKind::Record {
                            "record"
                        } else {
                            "file"
                        },
                        object.id
                    ),
                    error,
                );
            }
            if output.sink_failed || (grep.quiet && output.matched) {
                break;
            }
        }
    }
    output.finish(grep.quiet)
}

#[cfg(test)]
#[path = "cli_grep_tests.rs"]
mod tests;
