//! Bounded read-only projections of a native-owned immutable Office baseline.
use crate::agent::errors::{AgentError, AgentResult, ErrorCode};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ViewRange {
    pub start_row: u32,
    pub end_row: u32,
    pub start_column: u32,
    pub end_column: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum OfficeViewRead {
    #[serde(rename_all = "camelCase")]
    Range {
        sheet_id: String,
        range: ViewRange,
    },
    #[serde(rename_all = "camelCase")]
    Formulas {
        sheet_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Outline {
        sheet_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Media {
        visual_id: String,
    },
    Pivot {
        path: String,
    },
}
impl OfficeViewRead {
    pub(crate) fn validate(&self) -> AgentResult<()> {
        let valid_id = |id: &str, max| !id.is_empty() && id.len() <= max;
        let valid = match self {
            Self::Range { sheet_id, range: r } => {
                valid_id(sheet_id, 512)
                    && r.start_row <= r.end_row
                    && r.end_row <= 1_048_575
                    && r.start_column <= r.end_column
                    && r.end_column <= 16_383
                    && u64::from(r.end_row - r.start_row + 1)
                        * u64::from(r.end_column - r.start_column + 1)
                        <= 100_000
            }
            Self::Formulas { sheet_id } | Self::Outline { sheet_id } => valid_id(sheet_id, 512),
            Self::Media { visual_id } => valid_id(visual_id, 1024),
            Self::Pivot { path } => valid_id(path, 1024),
        };
        if valid {
            Ok(())
        } else {
            Err(AgentError::new(
                ErrorCode::InvalidArgument,
                "Invalid or unbounded Office view read",
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn office_view_reads_are_bounded_and_cannot_supply_capabilities() {
        let input = json!({"kind":"range","sheetId":"s","range":{"startRow":0,"endRow":99,"startColumn":0,"endColumn":25}});
        serde_json::from_value::<OfficeViewRead>(input.clone())
            .unwrap()
            .validate()
            .unwrap();
        for pointer in ["", "/range"] {
            let mut forged = input.clone();
            forged.pointer_mut(pointer).unwrap()["path"] = json!("/private");
            assert!(serde_json::from_value::<OfficeViewRead>(forged).is_err());
        }
        let mut large = input.clone();
        large["range"]["endRow"] = json!(1_048_575);
        assert!(serde_json::from_value::<OfficeViewRead>(large)
            .unwrap()
            .validate()
            .is_err());
    }
}
