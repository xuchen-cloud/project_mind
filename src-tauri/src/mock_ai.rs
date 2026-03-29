use serde_json::{json, Value};

pub struct DraftSuggestion {
    pub suggestion_type: String,
    pub title: String,
    pub preview: String,
    pub payload: Value,
}

pub fn generate(activity_title: &str, source_text: &str) -> Vec<DraftSuggestion> {
    let lines: Vec<String> = source_text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect();

    if lines.is_empty() {
        return vec![DraftSuggestion {
            suggestion_type: "todo".to_string(),
            title: "待办候选".to_string(),
            preview: "整理本次活动的关键结论并确认下一步".to_string(),
            payload: json!({
                "title": "整理本次活动的关键结论并确认下一步",
                "description": "当前记录内容较少，建议先完成本次活动的沉淀。",
                "priority": "medium"
            }),
        }];
    }

    let mut suggestions = Vec::new();
    let first_line = lines[0].clone();
    let fallback_title = if activity_title.trim().is_empty() {
        format!("围绕 {} 的推进对齐", truncate(&first_line, 18))
    } else {
        format!("{} - 阶段整理", truncate(activity_title, 18))
    };

    suggestions.push(DraftSuggestion {
        suggestion_type: "activity_title".to_string(),
        title: "活动标题建议".to_string(),
        preview: fallback_title.clone(),
        payload: json!({
            "proposedTitle": fallback_title
        }),
    });

    let conclusion_candidates = extract_conclusion_lines(&lines);
    for content in conclusion_candidates.into_iter().take(2) {
        suggestions.push(DraftSuggestion {
            suggestion_type: "conclusion".to_string(),
            title: "结论候选".to_string(),
            preview: content.clone(),
            payload: json!({
                "content": content,
                "promotedToProject": true
            }),
        });
    }

    let todo_candidates = extract_todo_lines(&lines);
    for item in todo_candidates.into_iter().take(2) {
        suggestions.push(DraftSuggestion {
            suggestion_type: "todo".to_string(),
            title: "待办候选".to_string(),
            preview: item.clone(),
            payload: json!({
                "title": item,
                "description": "来自 AI Mock 的活动跟进行动建议。",
                "priority": "medium"
            }),
        });
    }

    suggestions
}

fn extract_conclusion_lines(lines: &[String]) -> Vec<String> {
    let mut result: Vec<String> = lines
        .iter()
        .filter(|line| {
            ["结论", "决定", "确认", "统一", "采用", "建议", "共识"]
                .iter()
                .any(|keyword| line.contains(keyword))
        })
        .cloned()
        .collect();

    if result.is_empty() {
        result.push(format!("阶段判断：{}", truncate(&lines[0], 40)));
    }

    dedupe(result)
}

fn extract_todo_lines(lines: &[String]) -> Vec<String> {
    let mut result: Vec<String> = lines
        .iter()
        .filter(|line| {
            ["待", "跟进", "需要", "安排", "补充", "确认", "推进", "提交"]
                .iter()
                .any(|keyword| line.contains(keyword))
        })
        .map(|line| {
            if line.len() > 28 {
                truncate(line, 28).to_string()
            } else {
                line.to_string()
            }
        })
        .collect();

    if result.is_empty() {
        result.push("梳理活动结论并同步下一步责任人".to_string());
    }

    dedupe(result)
}

fn dedupe(items: Vec<String>) -> Vec<String> {
    let mut unique = Vec::new();
    for item in items {
        if !unique.contains(&item) {
            unique.push(item);
        }
    }
    unique
}

fn truncate(text: &str, limit: usize) -> String {
    let mut out = String::new();
    for ch in text.chars().take(limit) {
        out.push(ch);
    }
    out
}
