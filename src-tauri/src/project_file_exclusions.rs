//! Names reserved by external editors and the OS for transient working files.
//! Sources and intentional omissions are recorded in the requirement document.

pub(crate) fn is_temporary_file_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let extension = lower.rsplit_once('.').map(|(_, extension)| extension);
    let vim_swap = |suffix: &str| {
        suffix.len() == 3 && suffix.starts_with("sw") && matches!(suffix.as_bytes()[2], b'a'..=b'p')
    };
    name.starts_with("~$")
        || name.ends_with('~')
        || (name.len() > 1 && name.starts_with('#') && name.ends_with('#'))
        || extension.is_some_and(|extension| {
            matches!(extension, "tmp" | "temp") || extension.starts_with("~vsd")
        })
        || lower
            .strip_prefix('_')
            .is_some_and(|suffix| extension.map(vim_swap).unwrap_or_else(|| vim_swap(suffix)))
        || matches!(
            lower.as_str(),
            "thumbs.db"
                | "thumbs.db:encryptable"
                | "ehthumbs.db"
                | "ehthumbs_vista.db"
                | "desktop.ini"
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temporary_file_patterns_cover_office_editors_and_system_caches() {
        for name in [
            "~$解除终止劳动关系.docx",
            "~$book.XLSX",
            "~$slides.pptx",
            "~$owner",
            "~WRD1234.tmp",
            "scratch.TEMP",
            "drawing.~vsdx",
            "#draft#",
            "draft.txt~",
            "_draft.swp",
            "_draft.SWO",
            "_draft.swn",
            "_swp",
            "Thumbs.db",
            "THUMBS.DB",
            "ehthumbs.db",
            "ehthumbs_vista.db",
            "Desktop.INI",
        ] {
            assert!(is_temporary_file_name(name), "{name}");
        }
    }

    #[test]
    fn temporary_rules_keep_documents_recovery_backups_and_business_lock_files() {
        for name in [
            "劳动关系.docx",
            "book.xlsx",
            "slides.pptx",
            "report.tmp.docx",
            "draft.temp.pdf",
            "document.asd",
            "document.wbk",
            "book.xlk",
            "document.bak",
            "Backup of draft.docx",
            "Cargo.lock",
            "package-lock.json",
            "yarn.lock",
            "diagram.svg",
            "_diagram.svg",
            "macro.swp",
            "_draft.swq",
            "#heading.docx",
            "draft~final.docx",
            "Thumbs.db.txt",
        ] {
            assert!(!is_temporary_file_name(name), "{name}");
        }
    }
}
