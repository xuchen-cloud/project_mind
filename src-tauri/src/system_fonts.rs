use std::collections::HashSet;

use anyhow::Result;

#[cfg(any(target_os = "macos", target_os = "windows"))]
use font_kit::source::SystemSource;

pub fn list_system_font_families() -> Result<Vec<String>> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let families = SystemSource::new().all_families()?;
        return Ok(sort_and_dedup_font_families(families));
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(Vec::new())
    }
}

fn sort_and_dedup_font_families(families: Vec<String>) -> Vec<String> {
    let mut deduped = Vec::new();
    let mut seen = HashSet::new();

    for family in families {
        let trimmed = family.trim();
        if trimmed.is_empty() {
            continue;
        }

        let key = trimmed.to_lowercase();
        if seen.insert(key) {
            deduped.push(trimmed.to_string());
        }
    }

    deduped.sort_by_cached_key(|family| family.to_lowercase());
    deduped
}

#[cfg(test)]
mod tests {
    use super::sort_and_dedup_font_families;

    #[test]
    fn sort_and_dedup_font_families_normalizes_whitespace_and_case() {
        let families = sort_and_dedup_font_families(vec![
            "  Work Sans  ".to_string(),
            "Arial".to_string(),
            "work sans".to_string(),
            "".to_string(),
            "PingFang SC".to_string(),
        ]);

        assert_eq!(
            families,
            vec![
                "Arial".to_string(),
                "PingFang SC".to_string(),
                "Work Sans".to_string(),
            ]
        );
    }
}
