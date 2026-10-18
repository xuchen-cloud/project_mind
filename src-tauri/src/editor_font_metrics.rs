//! Installed-font vertical metrics for the GenOffice Word host.

use serde::Serialize;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceVerticalMetrics {
    pub units_per_em: u16,
    pub hhea_ascender: i16,
    pub hhea_descender: i16,
    pub hhea_line_gap: i16,
    pub typo_ascender: Option<i16>,
    pub typo_descender: Option<i16>,
    pub typo_line_gap: Option<i16>,
    pub win_ascent: Option<u16>,
    pub win_descent: Option<u16>,
    pub use_typo_metrics: bool,
}

#[tauri::command]
pub fn desktop_editor_font_metrics(family: String) -> Result<Option<FaceVerticalMetrics>, String> {
    if family.is_empty() || family.len() > 256 {
        return Err("Font family must contain 1–256 UTF-8 bytes".into());
    }
    let key = normalize_family(&family)?;
    if key.is_empty() {
        return Err("Font family must not be empty after normalization".into());
    }
    installed_family_metrics(&key)
}

fn parse_face_metrics(
    head: Option<&[u8]>,
    hhea: Option<&[u8]>,
    os2: Option<&[u8]>,
) -> Option<FaceVerticalMetrics> {
    // Match upstream's bounded table reads and independent OS/2 field groups.
    let head = head.filter(|table| (20..=512).contains(&table.len()))?;
    let hhea = hhea.filter(|table| (10..=512).contains(&table.len()))?;
    let units_per_em = u16_at(head, 18)?;
    if units_per_em == 0 {
        return None;
    }
    let os2 = os2.filter(|table| table.len() <= 512);
    let typo = os2.filter(|table| table.len() >= 74);
    let win = os2.filter(|table| table.len() >= 78);
    Some(FaceVerticalMetrics {
        units_per_em,
        hhea_ascender: u16_at(hhea, 4)? as i16,
        hhea_descender: u16_at(hhea, 6)? as i16,
        hhea_line_gap: u16_at(hhea, 8)? as i16,
        typo_ascender: typo.and_then(|table| u16_at(table, 68)).map(|n| n as i16),
        typo_descender: typo.and_then(|table| u16_at(table, 70)).map(|n| n as i16),
        typo_line_gap: typo.and_then(|table| u16_at(table, 72)).map(|n| n as i16),
        win_ascent: win.and_then(|table| u16_at(table, 74)),
        win_descent: win.and_then(|table| u16_at(table, 76)),
        use_typo_metrics: os2
            .and_then(|table| u16_at(table, 62))
            .is_some_and(|n| n & 0x80 != 0),
    })
}

fn u16_at(table: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        table.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn normalize_family(family: &str) -> Result<String, String> {
    // ECMAScript /[\s\-_]/ differs from Rust whitespace for U+0085 / U+FEFF.
    Ok(nfkc(family)?
        .to_lowercase()
        .chars()
        .filter(|c| {
            !matches!(c,
                '-' | '_' | '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' |
                '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' |
                '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
            )
        })
        .collect())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn installed_family_metrics(key: &str) -> Result<Option<FaceVerticalMetrics>, String> {
    let mut selected = None;
    for font in installed_fonts()? {
        let table = font.load_font_table(u32::from_be_bytes(*b"name"));
        let (families, subfamilies) = face_names(table.as_deref());
        let mut matches = false;
        for family in &families {
            matches |= normalize_family(family)? == key;
        }
        if !matches {
            continue;
        }
        let style = families
            .into_iter()
            .chain(subfamilies)
            .collect::<Vec<_>>()
            .join(" ");
        let score = style_score(&normalize_family(&style)?);
        if selected.as_ref().is_none_or(|(best, _)| score > *best) {
            selected = Some((score, font));
        }
    }
    let Some((_, font)) = selected else {
        return Ok(None);
    };
    let head = font.load_font_table(u32::from_be_bytes(*b"head"));
    let hhea = font.load_font_table(u32::from_be_bytes(*b"hhea"));
    let os2 = font.load_font_table(u32::from_be_bytes(*b"OS/2"));
    Ok(parse_face_metrics(
        head.as_deref(),
        hhea.as_deref(),
        os2.as_deref(),
    ))
}

#[cfg(target_os = "windows")]
fn installed_fonts() -> Result<Vec<font_kit::font::Font>, String> {
    font_kit::source::SystemSource::new()
        .all_fonts()
        .map_err(|e| format!("Enumerate fonts: {e}"))?
        .into_iter()
        .map(|handle| {
            handle
                .load()
                .map_err(|e| format!("Load installed font: {e}"))
        })
        .collect()
}

#[cfg(target_os = "macos")]
use macos::installed_fonts;

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;
    type Ref = *const c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(value: Ref);
        fn CFArrayGetCount(array: Ref) -> isize;
        fn CFArrayGetValueAtIndex(array: Ref, index: isize) -> Ref;
        fn CFDataGetLength(data: Ref) -> isize;
        fn CFDataGetBytePtr(data: Ref) -> *const u8;
    }
    #[link(name = "CoreText", kind = "framework")]
    extern "C" {
        fn CTFontCollectionCreateFromAvailableFonts(options: Ref) -> Ref;
        fn CTFontCollectionCreateMatchingFontDescriptors(collection: Ref) -> Ref;
        fn CTFontCreateWithFontDescriptor(descriptor: Ref, size: f64, matrix: Ref) -> Ref;
        fn CTFontCopyTable(font: Ref, tag: u32, options: u32) -> Ref;
    }
    pub(super) struct Font(Ref);
    impl Drop for Font {
        fn drop(&mut self) {
            // SAFETY: each Font owns one nonnull CoreFoundation Create/Copy reference.
            unsafe { CFRelease(self.0) }
        }
    }
    impl Font {
        pub(super) fn load_font_table(&self, tag: u32) -> Option<Box<[u8]>> {
            // SAFETY: valid owned CTFont; copied CFData remains alive while bytes are copied.
            unsafe {
                let data = CTFontCopyTable(self.0, tag, 0);
                if data.is_null() {
                    return None;
                }
                let data = Font(data);
                let length = CFDataGetLength(data.0);
                if !(2..=1 << 20).contains(&length) {
                    return None;
                }
                Some(std::slice::from_raw_parts(CFDataGetBytePtr(data.0), length as usize).into())
            }
        }
    }
    pub(super) fn installed_fonts() -> Result<Vec<Font>, String> {
        // font-kit's CoreTextSource::all_fonts slurps each TTC into memory.
        // Enumerate the same native collection and read only individual tables.
        // SAFETY: collection owns the borrowed descriptor array; each CTFont is retained by Create.
        unsafe {
            let collection = CTFontCollectionCreateFromAvailableFonts(std::ptr::null());
            if collection.is_null() {
                return Err("Enumerate native fonts failed".into());
            }
            let collection = Font(collection);
            // CoreText's descriptor array follows the Get rule despite the Create name.
            let descriptors = CTFontCollectionCreateMatchingFontDescriptors(collection.0);
            if descriptors.is_null() {
                return Err("Read installed font descriptors failed".into());
            }
            let mut fonts = Vec::new();
            for index in 0..CFArrayGetCount(descriptors) {
                let font = CTFontCreateWithFontDescriptor(
                    CFArrayGetValueAtIndex(descriptors, index),
                    0.0,
                    std::ptr::null(),
                );
                if font.is_null() {
                    return Err("Load installed native font failed".into());
                }
                fonts.push(Font(font));
            }
            Ok(fonts)
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn installed_family_metrics(_: &str) -> Result<Option<FaceVerticalMetrics>, String> {
    Err("Installed font metrics require macOS or Windows".into())
}

// Upstream ranks names 1/16 + 2/17 across languages, not approximate native weights.
fn face_names(table: Option<&[u8]>) -> (Vec<String>, Vec<String>) {
    let Some(table) = table.filter(|t| (6..=1 << 20).contains(&t.len())) else {
        return (Vec::new(), Vec::new());
    };
    let count = u16_at(table, 2).unwrap() as usize;
    let base = u16_at(table, 4).unwrap() as usize;
    let mut families = Vec::new();
    let mut subfamilies = Vec::new();
    for record in table[6..].chunks_exact(12).take(count) {
        let list = match u16_at(record, 6).unwrap() {
            1 | 16 => &mut families,
            2 | 17 => &mut subfamilies,
            _ => continue,
        };
        let length = u16_at(record, 8).unwrap() as usize;
        let offset = base + u16_at(record, 10).unwrap() as usize;
        let Some(bytes) = table.get(offset..offset + length) else {
            continue;
        };
        let name = match (u16_at(record, 0).unwrap(), u16_at(record, 2).unwrap()) {
            (0 | 3, _) if bytes.len() % 2 == 0 => String::from_utf16_lossy(
                &bytes
                    .chunks_exact(2)
                    .map(|b| u16::from_be_bytes([b[0], b[1]]))
                    .collect::<Vec<_>>(),
            ),
            (1, 0) => bytes.iter().map(|b| char::from(*b)).collect(),
            _ => continue,
        };
        if !name.is_empty() && !list.contains(&name) {
            list.push(name);
        }
    }
    (families, subfamilies)
}

// styleScore(face, []): longest tokens first, regular-ish bonus minus extras.
fn style_score(style: &str) -> i32 {
    const TOKENS: &[&str] = &[
        "semibold",
        "extrabold",
        "demibold",
        "demi",
        "bold",
        "italic",
        "oblique",
        "light",
        "thin",
        "medium",
        "heavy",
        "black",
        "regular",
    ];
    let mut remaining = style;
    let mut regular = false;
    let mut extras = 0;
    while !remaining.is_empty() {
        let token = TOKENS
            .iter()
            .copied()
            .find(|token| remaining.starts_with(token))
            .or_else(|| {
                let bytes = remaining.as_bytes();
                (bytes.len() >= 2 && bytes[0] == b'w' && bytes[1].is_ascii_digit())
                    .then(|| &remaining[..2])
            });
        if let Some(token) = token {
            if matches!(token, "regular" | "medium" | "w3" | "w4") {
                regular = true;
            } else {
                extras += 1;
            }
            remaining = &remaining[token.len()..];
        } else {
            remaining = &remaining[remaining.chars().next().unwrap().len_utf8()..];
        }
    }
    i32::from(regular) - extras
}

#[cfg(target_os = "macos")]
fn nfkc(value: &str) -> Result<String, String> {
    use std::ffi::c_void;
    #[repr(C)]
    struct CFRange {
        location: isize,
        length: isize,
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateMutable(allocator: *const c_void, max_length: isize) -> *mut c_void;
        fn CFStringAppendCharacters(string: *mut c_void, chars: *const u16, count: isize);
        fn CFStringNormalize(string: *mut c_void, form: isize);
        fn CFStringGetLength(string: *const c_void) -> isize;
        fn CFStringGetCharacters(string: *const c_void, range: CFRange, buffer: *mut u16);
        fn CFRelease(value: *const c_void);
    }
    let input: Vec<u16> = value.encode_utf16().collect();
    // SAFETY: owned mutable CFString, valid UTF-16 slices and exact output range.
    unsafe {
        let string = CFStringCreateMutable(std::ptr::null(), 0);
        if string.is_null() {
            return Err("Create font-family normalization string failed".into());
        }
        CFStringAppendCharacters(string, input.as_ptr(), input.len() as isize);
        CFStringNormalize(string, 3); // kCFStringNormalizationFormKC
        let length = CFStringGetLength(string);
        let mut output = vec![0; length as usize];
        CFStringGetCharacters(
            string,
            CFRange {
                location: 0,
                length,
            },
            output.as_mut_ptr(),
        );
        CFRelease(string);
        String::from_utf16(&output).map_err(|e| format!("Normalize font family: {e}"))
    }
}

#[cfg(target_os = "windows")]
fn nfkc(value: &str) -> Result<String, String> {
    #[link(name = "normaliz")]
    extern "system" {
        fn NormalizeString(
            form: i32,
            input: *const u16,
            input_len: i32,
            output: *mut u16,
            output_len: i32,
        ) -> i32;
    }
    if value.is_empty() {
        return Ok(String::new());
    }
    let input: Vec<u16> = value.encode_utf16().collect();
    let input_len = i32::try_from(input.len()).map_err(|_| "Font family is too long")?;
    // SAFETY: explicit UTF-16 lengths; API first supplies the output capacity.
    unsafe {
        let capacity = NormalizeString(5, input.as_ptr(), input_len, std::ptr::null_mut(), 0);
        if capacity <= 0 {
            return Err(format!(
                "Normalize font family: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut output = vec![0; capacity as usize];
        let length = NormalizeString(5, input.as_ptr(), input_len, output.as_mut_ptr(), capacity);
        if length <= 0 {
            return Err(format!(
                "Normalize font family: {}",
                std::io::Error::last_os_error()
            ));
        }
        output.truncate(length as usize);
        String::from_utf16(&output).map_err(|e| format!("Normalize font family: {e}"))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn nfkc(_: &str) -> Result<String, String> {
    Err("Font-family normalization requires macOS or Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tables() -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let mut head = vec![0; 54];
        head[18..20].copy_from_slice(&2048_u16.to_be_bytes());
        let mut hhea = vec![0; 36];
        for (offset, value) in [(4, 1900_i16), (6, -500), (8, -20)] {
            hhea[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
        }
        let mut os2 = vec![0; 96];
        os2[62..64].copy_from_slice(&0x80_u16.to_be_bytes());
        for (offset, value) in [(68, 1600_i16), (70, -400), (72, 200)] {
            os2[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
        }
        os2[74..76].copy_from_slice(&40000_u16.to_be_bytes());
        os2[76..78].copy_from_slice(&33000_u16.to_be_bytes());
        (head, hhea, os2)
    }

    #[test]
    fn raw_tables_preserve_signed_typo_unsigned_win_and_wire_contract() {
        let (head, hhea, os2) = tables();
        let metrics = parse_face_metrics(Some(&head), Some(&hhea), Some(&os2)).unwrap();
        assert_eq!(
            serde_json::to_value(metrics).unwrap(),
            serde_json::json!({
                "unitsPerEm": 2048, "hheaAscender": 1900, "hheaDescender": -500,
                "hheaLineGap": -20, "typoAscender": 1600, "typoDescender": -400,
                "typoLineGap": 200, "winAscent": 40000, "winDescent": 33000,
                "useTypoMetrics": true,
            })
        );
    }

    #[test]
    fn absent_and_partial_os2_follow_upstream_field_boundaries() {
        let (head, hhea, os2) = tables();
        for len in [0, 1, 62, 63, 64, 73, 74, 77, 78] {
            let metrics = parse_face_metrics(Some(&head), Some(&hhea), Some(&os2[..len])).unwrap();
            assert_eq!(metrics.use_typo_metrics, len >= 64);
            assert_eq!(metrics.typo_ascender, (len >= 74).then_some(1600));
            assert_eq!(metrics.typo_descender, (len >= 74).then_some(-400));
            assert_eq!(metrics.typo_line_gap, (len >= 74).then_some(200));
            assert_eq!(metrics.win_ascent, (len >= 78).then_some(40000));
            assert_eq!(metrics.win_descent, (len >= 78).then_some(33000));
        }
        let mut metrics = parse_face_metrics(Some(&head), Some(&hhea), None).unwrap();
        assert!(!metrics.use_typo_metrics);
        assert_eq!(metrics.typo_ascender, None);
        assert_eq!(metrics.win_ascent, None);
        assert!(serde_json::to_value(&metrics).unwrap()["typoAscender"].is_null());
        let mut os2 = os2;
        os2[62..64].copy_from_slice(&0x40_u16.to_be_bytes());
        metrics = parse_face_metrics(Some(&head), Some(&hhea), Some(&os2)).unwrap();
        assert!(!metrics.use_typo_metrics);
    }

    #[test]
    fn missing_short_oversized_or_zero_units_required_tables_are_a_miss() {
        let (mut head, hhea, os2) = tables();
        for table in [None, Some(&head[..19]), Some(&[0; 513][..])] {
            assert_eq!(parse_face_metrics(table, Some(&hhea), Some(&os2)), None);
        }
        for table in [None, Some(&hhea[..9]), Some(&[0; 513][..])] {
            assert_eq!(parse_face_metrics(Some(&head), table, Some(&os2)), None);
        }
        assert!(parse_face_metrics(Some(&head[..20]), Some(&hhea[..10]), None).is_some());
        head[18..20].fill(0);
        assert_eq!(
            parse_face_metrics(Some(&head), Some(&hhea), Some(&os2)),
            None
        );
    }

    #[test]
    fn oversized_os2_is_unavailable_as_in_upstream_bounded_reads() {
        let (head, hhea, _) = tables();
        let os2 = [0xff; 513];
        let metrics = parse_face_metrics(Some(&head), Some(&hhea), Some(&os2)).unwrap();
        assert!(!metrics.use_typo_metrics);
        assert_eq!(metrics.typo_ascender, None);
        assert_eq!(metrics.win_ascent, None);
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn family_normalization_matches_nfkc_lowercase_and_ecmascript_whitespace() {
        for name in ["Arial", "ＡＲＩＡＬ", " A_r-i\u{feff}al\u{2003}"] {
            assert_eq!(normalize_family(name).unwrap(), "arial");
        }
        assert_eq!(
            normalize_family("Cafe\u{301}").unwrap(),
            normalize_family("CAFÉ").unwrap()
        );
        assert_eq!(normalize_family("\u{fb01} Font").unwrap(), "fifont");
        assert_eq!(normalize_family("a\u{85}b").unwrap(), "a\u{85}b");
        assert_eq!(normalize_family("ΟΣ").unwrap(), "ος");
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn invalid_input_is_rejected_before_system_selection() {
        for family in [
            "".into(),
            " -_\u{feff}\t".into(),
            "a".repeat(257),
            "字".repeat(86),
        ] {
            assert!(desktop_editor_font_metrics(family).is_err());
        }
        assert_eq!(desktop_editor_font_metrics("a".repeat(256)).unwrap(), None);
    }

    #[test]
    fn regular_style_scoring_matches_upstream_token_priority() {
        assert_eq!(style_score("samplefamilyregular"), 1);
        assert_eq!(style_score("samplefamilymedium"), 1);
        assert_eq!(style_score("samplefamilyw3"), 1);
        assert_eq!(style_score("samplefamilyw4"), 1);
        assert_eq!(style_score("samplefamily"), 0);
        assert_eq!(style_score("samplefamilysemibold"), -1);
        assert_eq!(style_score("samplefamilydemibold"), -1);
        assert_eq!(style_score("samplefamilydemi"), -1);
        assert_eq!(style_score("samplefamilybolditalic"), -2);
        assert_eq!(style_score("samplefamilyregularoblique"), 0);
        assert_eq!(style_score("samplefamilyw5"), -1);
    }

    #[test]
    fn style_names_read_unicode_subfamilies_and_skip_broken_records() {
        let name: Vec<u8> = "Regular"
            .encode_utf16()
            .flat_map(u16::to_be_bytes)
            .collect();
        let mut table = vec![0; 18];
        for (offset, value) in [
            (2, 1_u16),
            (4, 18),
            (6, 3),
            (12, 17),
            (14, name.len() as u16),
        ] {
            table[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
        }
        table.extend(name);
        assert_eq!(face_names(Some(&table)), (vec![], vec!["Regular".into()]));
        table[16..18].copy_from_slice(&u16::MAX.to_be_bytes());
        assert_eq!(face_names(Some(&table)), (vec![], vec![]));
        assert_eq!(face_names(Some(&table[..5])), (vec![], vec![]));
        assert_eq!(face_names(None), (vec![], vec![]));
    }

    #[test]
    fn multilingual_name_id_1_and_16_are_both_exact_family_aliases() {
        let records = [
            (1, 0x0409, "Sample Family"),
            (16, 0x0804, "示例字体"),
            (17, 0x0804, "Regular"),
        ];
        let mut table = vec![0; 6 + 12 * records.len()];
        let base = table.len();
        table[2..4].copy_from_slice(&(records.len() as u16).to_be_bytes());
        table[4..6].copy_from_slice(&(base as u16).to_be_bytes());
        for (index, (id, language, text)) in records.into_iter().enumerate() {
            let bytes: Vec<u8> = text.encode_utf16().flat_map(u16::to_be_bytes).collect();
            let position = 6 + 12 * index;
            for (offset, value) in [
                (0, 3_u16),
                (2, 1),
                (4, language),
                (6, id),
                (8, bytes.len() as u16),
                (10, (table.len() - base) as u16),
            ] {
                table[position + offset..position + offset + 2]
                    .copy_from_slice(&value.to_be_bytes());
            }
            table.extend(bytes);
        }
        let (families, subfamilies) = face_names(Some(&table));
        assert_eq!(families, ["Sample Family", "示例字体"]);
        assert_eq!(subfamilies, ["Regular"]);
        assert!(!families.iter().any(|name| name == "示例"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn installed_cjk_localized_alias_matches_its_real_name_table_family() {
        let mut alias = None;
        for font in installed_fonts().unwrap() {
            let table = font.load_font_table(u32::from_be_bytes(*b"name"));
            let (families, _) = face_names(table.as_deref());
            if families.iter().any(|name| name == "PingFang SC") {
                alias = families
                    .into_iter()
                    .find(|name| name.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)));
                if alias.is_some() {
                    break;
                }
            }
        }
        let alias =
            alias.expect("Installed PingFang SC must expose its actual CJK name table alias");
        let localized = desktop_editor_font_metrics(alias.clone()).unwrap();
        assert!(
            localized.is_some(),
            "Installed exact name-table alias was rejected: {alias}"
        );
        assert_eq!(
            localized,
            desktop_editor_font_metrics("PingFang SC".into()).unwrap()
        );
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn installed_arial_returns_actual_regular_face_table_values() {
        use font_kit::{
            properties::{Style, Weight},
            source::SystemSource,
        };
        let family = SystemSource::new().select_family_by_name("Arial").unwrap();
        let font = family
            .fonts()
            .iter()
            .map(|h| h.load().unwrap())
            .find(|f| {
                let properties = f.properties();
                properties.style == Style::Normal && properties.weight == Weight::NORMAL
            })
            .expect("Arial Regular must be installed on the desktop test machine");
        let actual = desktop_editor_font_metrics("Ａｒｉａｌ".into())
            .unwrap()
            .unwrap();
        let head = font.load_font_table(u32::from_be_bytes(*b"head")).unwrap();
        let hhea = font.load_font_table(u32::from_be_bytes(*b"hhea")).unwrap();
        let os2 = font.load_font_table(u32::from_be_bytes(*b"OS/2"));
        assert_eq!(
            Some(actual),
            parse_face_metrics(Some(&head), Some(&hhea), os2.as_deref())
        );
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn unknown_family_and_near_match_never_substitute_an_installed_font() {
        for family in [
            "ProjectMindMissingFont9d7b4ec1",
            "Arial Definitely Missing 9d7b4ec1",
        ] {
            assert_eq!(desktop_editor_font_metrics(family.into()).unwrap(), None);
        }
    }
}
