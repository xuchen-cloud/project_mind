use super::local_asr::LocalAsrResult;

const SAMPLE_RATE: u64 = 16_000;
const SOFT_LIMIT_SAMPLES: u64 = 12 * SAMPLE_RATE;
const HARD_LIMIT_SAMPLES: u64 = 30 * SAMPLE_RATE;

/// Holds unfinished text across an audio safety split. SenseVoice often adds
/// terminal punctuation at the end of a forced chunk even when speech continues.
pub struct SentenceAssembler {
    pending: String,
    start_sample: Option<u64>,
    end_sample: u64,
}

impl SentenceAssembler {
    pub fn new() -> Self {
        Self {
            pending: String::new(),
            start_sample: None,
            end_sample: 0,
        }
    }

    pub fn push(&mut self, result: LocalAsrResult) -> Vec<LocalAsrResult> {
        let mut incoming = result.text.trim().to_string();
        if result.forced_split {
            incoming = incoming
                .trim_end_matches(|ch: char| ch.is_whitespace() || is_terminal(ch))
                .to_string();
        }
        if incoming.is_empty() {
            return Vec::new();
        }
        if self.start_sample.is_none() {
            self.start_sample = Some(result.start_sample);
        }
        self.end_sample = result.end_sample;
        let overlap = common_boundary_chars(&self.pending, &incoming);
        let incoming = incoming.chars().skip(overlap).collect::<String>();
        if self
            .pending
            .chars()
            .last()
            .is_some_and(|ch| ch.is_ascii_alphanumeric())
            && incoming
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_alphanumeric())
        {
            self.pending.push(' ');
        }
        self.pending.push_str(&incoming);

        let mut completed = Vec::new();
        while let Some(boundary) = sentence_boundary(&self.pending) {
            completed.push(self.drain_through(boundary));
        }
        if self
            .start_sample
            .is_some_and(|start| self.end_sample.saturating_sub(start) >= SOFT_LIMIT_SAMPLES)
        {
            if let Some(boundary) = clause_boundary(&self.pending) {
                completed.push(self.drain_through(boundary));
            }
        }
        if self
            .start_sample
            .is_some_and(|start| self.end_sample.saturating_sub(start) >= HARD_LIMIT_SAMPLES)
        {
            if let Some(tail) = self.finish() {
                completed.push(tail);
            }
        }
        if !result.forced_split {
            if let Some(tail) = self.finish() {
                completed.push(tail);
            }
        }
        completed
    }

    pub fn finish(&mut self) -> Option<LocalAsrResult> {
        if self.pending.trim().is_empty() {
            self.pending.clear();
            self.start_sample = None;
            return None;
        }
        let text = std::mem::take(&mut self.pending).trim().to_string();
        let start_sample = self.start_sample.take().unwrap_or(self.end_sample);
        Some(LocalAsrResult {
            start_sample,
            end_sample: self.end_sample.max(start_sample + 1),
            text,
            forced_split: false,
        })
    }

    pub fn preview_text(&self, raw: &str) -> String {
        merge_preview_text(&self.pending, raw)
    }

    fn drain_through(&mut self, byte_end: usize) -> LocalAsrResult {
        let total_chars = self.pending.chars().count().max(1) as u64;
        let drained_chars = self.pending[..byte_end].chars().count() as u64;
        let start_sample = self.start_sample.unwrap_or(self.end_sample);
        let end_sample = start_sample
            + self.end_sample.saturating_sub(start_sample) * drained_chars / total_chars;
        let text = self
            .pending
            .drain(..byte_end)
            .collect::<String>()
            .trim()
            .to_string();
        self.pending = self.pending.trim_start().to_string();
        self.start_sample = if self.pending.is_empty() {
            None
        } else {
            Some(end_sample)
        };
        LocalAsrResult {
            start_sample,
            end_sample: end_sample.max(start_sample + 1),
            text,
            forced_split: false,
        }
    }
}

/// Merge provisional speech fragments with the same overlap rule as final text.
pub(crate) fn merge_preview_text(previous: &str, raw: &str) -> String {
    let incoming = raw.trim();
    let overlap = common_boundary_chars(previous, incoming);
    let suffix = incoming.chars().skip(overlap).collect::<String>();
    let spacer = if previous
        .chars()
        .last()
        .is_some_and(|ch| ch.is_ascii_alphanumeric())
        && suffix
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphanumeric())
    {
        " "
    } else {
        ""
    };
    format!("{}{}{}", previous, spacer, suffix)
        .trim()
        .to_string()
}

fn is_terminal(ch: char) -> bool {
    matches!(ch, '。' | '！' | '？' | '.' | '!' | '?')
}

fn sentence_boundary(text: &str) -> Option<usize> {
    text.char_indices().find_map(|(at, ch)| {
        (is_terminal(ch)
            && !(ch == '.' && text[at + 1..].starts_with(|next: char| next.is_ascii_digit())))
        .then_some(at + ch.len_utf8())
    })
}

fn clause_boundary(text: &str) -> Option<usize> {
    text.char_indices()
        .filter_map(|(at, ch)| matches!(ch, '，' | ',' | '；' | ';').then_some(at + ch.len_utf8()))
        .last()
}

fn common_boundary_chars(previous: &str, next: &str) -> usize {
    let tail = previous.chars().rev().take(16).collect::<Vec<_>>();
    let head = next.chars().take(16).collect::<Vec<_>>();
    (2..=tail.len().min(head.len()))
        .rev()
        .find(|&size| {
            tail[..size]
                .iter()
                .rev()
                .copied()
                .eq(head[..size].iter().copied())
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provisional_fragments_merge_without_overwriting_final_assembly() {
        let first = merge_preview_text("", "我们确定周五发布");
        let combined = merge_preview_text(&first, "周五发布并通知客户");
        assert_eq!(combined, "我们确定周五发布并通知客户");
        let mut final_text = SentenceAssembler::new();
        final_text.push(LocalAsrResult {
            start_sample: 0,
            end_sample: 16_000,
            text: "已确认".into(),
            forced_split: true,
        });
        assert_eq!(
            final_text.preview_text(&combined),
            "已确认我们确定周五发布并通知客户"
        );
        assert_eq!(final_text.finish().unwrap().text, "已确认");
    }

    #[test]
    fn joins_forced_chunks_then_emits_at_sentence_boundary() {
        let mut assembler = SentenceAssembler::new();
        assert!(assembler
            .push(LocalAsrResult {
                start_sample: 0,
                end_sample: 160_000,
                text: "朋友们，俄罗斯跟乌克兰打了四年多了，你说现在的经济到底是什么。".into(),
                forced_split: true,
            })
            .is_empty());
        let sentences = assembler.push(LocalAsrResult {
            start_sample: 155_200,
            end_sample: 320_000,
            text: "什么情况？我们最近在新闻上看到的信息越来越少，".into(),
            forced_split: true,
        });
        assert_eq!(sentences.len(), 1);
        assert_eq!(
            sentences[0].text,
            "朋友们，俄罗斯跟乌克兰打了四年多了，你说现在的经济到底是什么情况？"
        );
        assert!(assembler.finish().unwrap().text.starts_with("我们最近"));
    }

    #[test]
    fn separates_multiple_complete_sentences_inside_one_recognition_result() {
        let mut assembler = SentenceAssembler::new();
        let sentences = assembler.push(LocalAsrResult {
            start_sample: 0,
            end_sample: 160_000,
            text: "第一句。第二句？第三句还没完".into(),
            forced_split: true,
        });
        assert_eq!(
            sentences
                .iter()
                .map(|item| item.text.as_str())
                .collect::<Vec<_>>(),
            vec!["第一句。", "第二句？"]
        );
        assert_eq!(assembler.finish().unwrap().text, "第三句还没完");
    }

    #[test]
    fn continuous_speech_uses_clause_boundary_before_waiting_for_a_long_paragraph() {
        let mut assembler = SentenceAssembler::new();
        assert!(assembler
            .push(LocalAsrResult {
                start_sample: 0,
                end_sample: 160_000,
                text: "首先咱们按时间顺序看一下，接下来继续分析".into(),
                forced_split: true,
            })
            .is_empty());
        let output = assembler.push(LocalAsrResult {
            start_sample: 154_400,
            end_sample: 320_000,
            text: "分析两边的经济变化".into(),
            forced_split: true,
        });
        assert_eq!(output.len(), 1);
        assert_eq!(output[0].text, "首先咱们按时间顺序看一下，");
        assert_eq!(
            assembler.finish().unwrap().text,
            "接下来继续分析两边的经济变化"
        );
    }

    #[test]
    fn a_decimal_point_does_not_end_a_sentence() {
        let mut assembler = SentenceAssembler::new();
        let output = assembler.push(LocalAsrResult {
            start_sample: 0,
            end_sample: 80_000,
            text: "增长了3.5%。下一句。".into(),
            forced_split: false,
        });
        assert_eq!(
            output
                .iter()
                .map(|part| part.text.as_str())
                .collect::<Vec<_>>(),
            vec!["增长了3.5%。", "下一句。"]
        );
    }
}
