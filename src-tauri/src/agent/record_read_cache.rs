//! Bounded immutable text projections, keyed by Workspace open generation.
use super::RecordReadFormat;
use crate::source_service::TextSpan;
use std::{
    collections::VecDeque,
    mem::size_of,
    sync::{Arc, Mutex, OnceLock},
};

const MAX_CACHE_BYTES: usize = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES: usize = 32;
const CHARACTER_CHECKPOINT: usize = 1024;

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Key {
    pub workspace: String,
    pub generation: String,
    pub object: String,
    pub revision: String,
    pub head_revision: u64,
    pub format: RecordReadFormat,
}
pub(super) struct Projection {
    pub text: String,
    pub spans: Vec<TextSpan>,
    lines: Vec<usize>,
    /// Sparse byte/character checkpoints avoid rescanning a long single line.
    characters: Vec<(usize, usize)>,
}
impl Projection {
    pub fn new(text: String, spans: Vec<TextSpan>) -> Self {
        let mut lines = if text.is_empty() { vec![] } else { vec![0] };
        let mut characters = vec![(0, 0)];
        for (character, (byte, value)) in text.char_indices().enumerate() {
            if character > 0 && character % CHARACTER_CHECKPOINT == 0 {
                characters.push((byte, character));
            }
            if value == '\n' && byte + 1 < text.len() {
                lines.push(byte + 1);
            }
        }
        Self {
            text,
            spans,
            lines,
            characters,
        }
    }
    pub fn total_lines(&self) -> usize {
        self.lines.len()
    }
    pub fn line_byte(&self, line: usize) -> usize {
        self.lines
            .get(line.saturating_sub(1))
            .copied()
            .unwrap_or(self.text.len())
    }
    pub fn line_at(&self, byte: usize) -> usize {
        self.lines.partition_point(|start| *start <= byte)
    }
    pub fn char_at(&self, byte: usize) -> usize {
        let index = self
            .characters
            .partition_point(|(start, _)| *start <= byte)
            .saturating_sub(1);
        let (start, count) = self.characters[index];
        count + self.text[start..byte].chars().count()
    }
    fn bytes(&self) -> usize {
        size_of::<Self>()
            + self.text.capacity()
            + self.spans.capacity() * size_of::<TextSpan>()
            + self
                .spans
                .iter()
                .map(|span| span.block_id.capacity())
                .sum::<usize>()
            + self.lines.capacity() * size_of::<usize>()
            + self.characters.capacity() * size_of::<(usize, usize)>()
    }
}
#[derive(Default)]
struct Cache {
    entries: VecDeque<(Key, Arc<Projection>, usize)>,
    bytes: usize,
}
impl Cache {
    fn get(&mut self, key: &Key) -> Option<Arc<Projection>> {
        let index = self
            .entries
            .iter()
            .position(|(candidate, _, _)| candidate == key)?;
        let entry = self.entries.remove(index)?;
        let result = entry.1.clone();
        self.entries.push_back(entry);
        Some(result)
    }
    fn insert(&mut self, key: Key, projection: Arc<Projection>) {
        let bytes = projection.bytes()
            + size_of::<Key>()
            + key.workspace.capacity()
            + key.generation.capacity()
            + key.object.capacity()
            + key.revision.capacity();
        // Oversized Records remain readable, but cannot evict the entire cache
        // and stay resident outside its byte budget.
        if bytes > MAX_CACHE_BYTES {
            return;
        }
        if let Some(index) = self
            .entries
            .iter()
            .position(|(candidate, _, _)| candidate == &key)
        {
            if let Some((_, _, previous)) = self.entries.remove(index) {
                self.bytes -= previous;
            }
        }
        while self.entries.len() >= MAX_CACHE_ENTRIES || self.bytes + bytes > MAX_CACHE_BYTES {
            if let Some((_, _, previous)) = self.entries.pop_front() {
                self.bytes -= previous;
            }
        }
        self.bytes += bytes;
        self.entries.push_back((key, projection, bytes));
    }
}
fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Cache::default()))
}
pub(super) fn get(key: &Key) -> Option<Arc<Projection>> {
    cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(key)
}
pub(super) fn insert(key: Key, projection: Arc<Projection>) {
    cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(key, projection);
}

#[cfg(test)]
mod tests {
    use super::*;
    fn key(index: usize) -> Key {
        Key {
            workspace: "w".into(),
            generation: "open".into(),
            object: index.to_string(),
            revision: "hash".into(),
            head_revision: 1,
            format: RecordReadFormat::Text,
        }
    }
    #[test]
    fn cache_bounds_and_generation_isolation() {
        let mut cache = Cache::default();
        for index in 0..MAX_CACHE_ENTRIES + 1 {
            cache.insert(key(index), Arc::new(Projection::new("body".into(), vec![])));
        }
        assert!(cache.get(&key(0)).is_none());
        assert_eq!(cache.entries.len(), MAX_CACHE_ENTRIES);
        let mut reopened = key(MAX_CACHE_ENTRIES);
        reopened.generation = "reopened".into();
        assert!(cache.get(&reopened).is_none());
        let mut markdown = key(MAX_CACHE_ENTRIES);
        markdown.format = RecordReadFormat::Markdown;
        assert!(cache.get(&markdown).is_none());
        let large = Arc::new(Projection::new("x".repeat(MAX_CACHE_BYTES + 1), vec![]));
        cache.insert(key(999), large);
        assert!(cache.get(&key(999)).is_none());
        assert!(cache.bytes <= MAX_CACHE_BYTES);
    }
    #[test]
    fn line_windows_and_character_checkpoints_preserve_unicode_and_trailing_newline() {
        let body = format!("{}\nsecond\n", "中文🙂".repeat(2000));
        let projection = Projection::new(body.clone(), vec![]);
        let second = projection.line_byte(2);
        assert_eq!(&body[second..], "second\n");
        assert_eq!(projection.total_lines(), 2);
        assert_eq!(projection.char_at(second), 6001);
        assert_eq!(projection.line_at(second), 2);
        assert_eq!(projection.line_byte(3), body.len());
    }
}
