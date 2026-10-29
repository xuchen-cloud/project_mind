//! Shared option spelling. Argument values remain literal, including backslashes
//! and values attached with `=`, and `--` is handled once by the common parser.
pub(super) fn flag(raw: &str) -> (&str, Option<&str>) {
    match raw {
        "-h" => ("--help", None),
        "-V" => ("--version", None),
        _ if raw.starts_with("--") => raw
            .split_once('=')
            .map_or((raw, None), |(flag, value)| (flag, Some(value))),
        _ => (raw, None),
    }
}
