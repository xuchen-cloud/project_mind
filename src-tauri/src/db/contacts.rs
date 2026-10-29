//! Shared address-book validation, literal search and revision-checked writes.
use super::{
    classify_internal_reference_match, derive_contact_search_abbr, derive_contact_search_text,
    normalize_contact_field, normalize_contact_pinyin, now_iso, validate_contact_name, Database,
    InternalReferenceMatchKind, WorkspaceSearchRank,
};
use crate::{
    agent::errors::{AgentError, AgentResult, ErrorCode},
    models::{ContactDeleteInput, ContactRecord, ContactSearchInput, ContactUpsertInput},
};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContactFields {
    #[serde(
        default,
        deserialize_with = "non_null_optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String", length(max = 64))]
    pub name: Option<String>,
    #[serde(
        default,
        deserialize_with = "non_null_optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String", length(max = 128))]
    pub pinyin_full: Option<String>,
    #[serde(
        default,
        deserialize_with = "non_null_optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String", length(max = 128))]
    pub pinyin_abbr: Option<String>,
    #[serde(
        default,
        deserialize_with = "non_null_optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String", length(max = 128))]
    pub email: Option<String>,
    #[serde(
        default,
        deserialize_with = "non_null_optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String", length(max = 64))]
    pub employee_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "non_null_optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String", length(max = 64))]
    pub role: Option<String>,
    #[serde(
        default,
        deserialize_with = "non_null_optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String", length(max = 64))]
    pub department: Option<String>,
    #[serde(
        default,
        deserialize_with = "non_null_optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String", length(max = 1000))]
    pub nicknames: Option<String>,
    #[serde(skip)]
    #[schemars(skip)]
    pub nickname_pinyin: Option<String>,
    #[serde(
        default,
        deserialize_with = "non_null_optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String", length(max = 10000))]
    pub notes: Option<String>,
}

// Missing keys use serde(default); a present value must be a string, including "".
fn non_null_optional_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContactPage {
    pub items: Vec<ContactRecord>,
    pub total_count: usize,
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<usize>,
}
const COLUMNS: &str = "id,name,pinyin_full,pinyin_abbr,email,employee_id,role,department,nicknames,notes,nickname_pinyin,revision,created_at,updated_at";
fn storage(error: rusqlite::Error) -> AgentError {
    AgentError::new(
        ErrorCode::IoFailed,
        format!("Contact database error: {error}"),
    )
}
fn invalid(message: impl Into<String>) -> AgentError {
    AgentError::new(ErrorCode::InvalidArgument, message)
}
fn legacy(error: AgentError) -> anyhow::Error {
    anyhow::anyhow!(error.message)
}
fn map(row: &Row<'_>) -> rusqlite::Result<ContactRecord> {
    Ok(ContactRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        pinyin_full: row.get(2)?,
        pinyin_abbr: row.get(3)?,
        email: row.get(4)?,
        employee_id: row.get(5)?,
        role: row.get(6)?,
        department: row.get(7)?,
        nicknames: row.get(8)?,
        notes: row.get(9)?,
        nickname_pinyin: row.get(10)?,
        revision: row.get::<_, i64>(11)? as u64,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}
pub(crate) fn get(conn: &Connection, id: i64) -> AgentResult<ContactRecord> {
    validate_id(id)?;
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM contacts WHERE id=?1"),
        [id],
        map,
    )
    .optional()
    .map_err(storage)?
    .ok_or_else(|| AgentError::new(ErrorCode::NotFound, "Contact not found"))
}
fn validate_id(id: i64) -> AgentResult<()> {
    if !(1..=9007199254740991).contains(&id) {
        return Err(invalid("Contact ID must be a positive safe integer"));
    }
    Ok(())
}
fn strings(contact: &ContactRecord) -> [&str; 10] {
    [
        &contact.name,
        &contact.pinyin_full,
        &contact.pinyin_abbr,
        &contact.email,
        &contact.employee_id,
        &contact.role,
        &contact.department,
        &contact.nicknames,
        &contact.nickname_pinyin,
        &contact.notes,
    ]
}
/// Field priority is absolute; match strength only breaks ties within a field.
/// Nickname pinyin is persisted as full/abbreviation pairs by the shared helper.
/// Empty aliases emit neither token; a capped final full token keeps its parity.
pub(super) fn search_rank(contact: &ContactRecord, query: &str) -> Option<WorkspaceSearchRank> {
    let mut fields = vec![
        (0, contact.employee_id.as_str()),
        (1, contact.email.as_str()),
        (2, contact.name.as_str()),
        (3, contact.nicknames.as_str()),
        (4, contact.pinyin_full.as_str()),
        (5, contact.pinyin_abbr.as_str()),
        (6, contact.department.as_str()),
        (6, contact.role.as_str()),
        (6, contact.notes.as_str()),
    ];
    fields.extend(contact.nicknames.split(';').map(|alias| (3, alias)));
    fields.extend(
        contact
            .nickname_pinyin
            .split_whitespace()
            .enumerate()
            .map(|(index, token)| (4 + (index % 2) as u8, token)),
    );
    fields
        .into_iter()
        .flat_map(|(field_priority, text)| {
            query.split_whitespace().filter_map(move |term| {
                classify_internal_reference_match(text, term).map(|match_kind| {
                    WorkspaceSearchRank {
                        field_priority,
                        match_kind,
                    }
                })
            })
        })
        .min()
}
/// Stream one row at a time; all consumers share Unicode case folding and literal AND terms.
pub(super) fn visit_matches(
    conn: &Connection,
    query: &str,
    mut visit: impl FnMut(ContactRecord),
) -> AgentResult<()> {
    let terms: Vec<_> = query.split_whitespace().map(str::to_lowercase).collect();
    let mut statement = conn
        .prepare(&format!("SELECT {COLUMNS} FROM contacts"))
        .map_err(storage)?;
    let rows = statement.query_map([], map).map_err(storage)?;
    for row in rows {
        let contact = row.map_err(storage)?;
        let fields = strings(&contact).map(str::to_lowercase);
        if terms
            .iter()
            .all(|term| fields.iter().any(|field| field.contains(term)))
        {
            visit(contact);
        }
    }
    Ok(())
}
pub(crate) fn search(
    conn: &Connection,
    query: &str,
    limit: usize,
    offset: usize,
) -> AgentResult<ContactPage> {
    if !(1..=200).contains(&limit) || query.chars().count() > 1000 {
        return Err(invalid(
            "Contact limit must be 1..200 and query at most 1000 characters",
        ));
    }
    // A read transaction keeps counting, page selection and row fetch on one snapshot.
    let transaction = if conn.is_autocommit() {
        Some(conn.unchecked_transaction().map_err(storage)?)
    } else {
        None
    };
    let mut matches = Vec::new();
    visit_matches(conn, query, |contact| {
        let rank = search_rank(&contact, query).unwrap_or(WorkspaceSearchRank {
            field_priority: 6,
            match_kind: InternalReferenceMatchKind::Contains,
        });
        matches.push((rank, contact.created_at, contact.id));
    })?;
    matches.sort_unstable_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| b.2.cmp(&a.2))
    });
    let total_count = matches.len();
    let ids: Vec<_> = matches
        .iter()
        .skip(offset)
        .take(limit)
        .map(|entry| entry.2)
        .collect();
    let mut items = Vec::with_capacity(ids.len());
    if !ids.is_empty() {
        let mut statement = conn
            .prepare(&format!(
                "SELECT {COLUMNS} FROM contacts WHERE id IN (SELECT value FROM json_each(?1))"
            ))
            .map_err(storage)?;
        let rows = statement
            .query_map([serde_json::to_string(&ids).expect("integer array")], map)
            .map_err(storage)?;
        for row in rows {
            items.push(row.map_err(storage)?);
        }
        items.sort_unstable_by_key(|item| {
            ids.iter()
                .position(|id| *id == item.id)
                .expect("selected ID")
        });
    }
    let next = offset.saturating_add(items.len());
    let has_more = next < total_count;
    if let Some(transaction) = transaction {
        transaction.commit().map_err(storage)?;
    }
    Ok(ContactPage {
        items,
        total_count,
        has_more,
        next_offset: has_more.then_some(next),
    })
}
fn normalized_field(value: &str, field: &str, max: usize) -> AgentResult<String> {
    normalize_contact_field(Some(value), field, max).map_err(|e| invalid(e.to_string()))
}
fn nicknames(value: &str) -> AgentResult<String> {
    if value.chars().count() > 1000 {
        return Err(invalid("nicknames must be 1000 characters or fewer"));
    }
    let mut parts = Vec::new();
    for part in value
        .split([';', '；'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        if !parts.contains(&part) {
            parts.push(part);
        }
    }
    Ok(parts.join(";"))
}
fn apply(contact: &mut ContactRecord, fields: &ContactFields) -> AgentResult<()> {
    if let Some(value) = &fields.name {
        let name = validate_contact_name(value).map_err(|e| invalid(e.to_string()))?;
        if name != contact.name {
            contact.name = name;
            // A renamed person must not keep matching the old name's pronunciation.
            // Chinese transliteration is supplied by the caller; the fallback is ASCII only.
            let full = derive_contact_search_text(&contact.name);
            if fields.pinyin_abbr.is_none() {
                contact.pinyin_abbr = derive_contact_search_abbr(&full);
            }
            if fields.pinyin_full.is_none() {
                contact.pinyin_full = full;
            }
        }
    }
    for (target, value, field, max) in [
        (
            &mut contact.pinyin_full,
            &fields.pinyin_full,
            "pinyinFull",
            128,
        ),
        (
            &mut contact.pinyin_abbr,
            &fields.pinyin_abbr,
            "pinyinAbbr",
            128,
        ),
        (&mut contact.email, &fields.email, "email", 128),
        (
            &mut contact.employee_id,
            &fields.employee_id,
            "employeeId",
            64,
        ),
        (&mut contact.role, &fields.role, "role", 64),
        (
            &mut contact.department,
            &fields.department,
            "department",
            64,
        ),
    ] {
        if let Some(value) = value {
            *target = normalized_field(value, field, max)?;
        }
    }
    if fields.pinyin_full.is_some() {
        contact.pinyin_full = contact.pinyin_full.to_lowercase();
    }
    if fields.pinyin_abbr.is_some() {
        contact.pinyin_abbr = contact.pinyin_abbr.to_lowercase();
    }
    if let Some(value) = &fields.nicknames {
        let next = nicknames(value)?;
        if next != contact.nicknames && fields.nickname_pinyin.is_none() {
            contact.nickname_pinyin.clear();
        }
        contact.nicknames = next;
    }
    if let Some(value) = &fields.nickname_pinyin {
        if value.chars().count() > 8192 {
            return Err(invalid("nicknamePinyin must be 8192 characters or fewer"));
        }
        contact.nickname_pinyin = value.trim().to_lowercase();
    }
    if let Some(value) = &fields.notes {
        if value.chars().count() > 10000 {
            return Err(invalid("notes must be 10000 characters or fewer"));
        }
        contact.notes = value.clone();
    }
    Ok(())
}
pub(crate) fn create(conn: &Connection, fields: &ContactFields) -> AgentResult<ContactRecord> {
    let name = validate_contact_name(fields.name.as_deref().unwrap_or(""))
        .map_err(|e| invalid(e.to_string()))?;
    let full = derive_contact_search_text(&name);
    let now = now_iso();
    let mut contact = ContactRecord {
        id: 0,
        name,
        pinyin_abbr: derive_contact_search_abbr(&full),
        pinyin_full: full,
        email: String::new(),
        employee_id: String::new(),
        role: String::new(),
        department: String::new(),
        nicknames: String::new(),
        nickname_pinyin: String::new(),
        notes: String::new(),
        revision: 1,
        created_at: now.clone(),
        updated_at: now,
    };
    apply(&mut contact, fields)?;
    conn.query_row(&format!("INSERT INTO contacts(name,pinyin_full,pinyin_abbr,email,employee_id,role,department,nicknames,notes,nickname_pinyin,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1,?11,?11) RETURNING {COLUMNS}"),
        params![contact.name,contact.pinyin_full,contact.pinyin_abbr,contact.email,contact.employee_id,contact.role,contact.department,contact.nicknames,contact.notes,contact.nickname_pinyin,contact.created_at],map).map_err(storage)
}
fn conflict(current_revision: u64) -> AgentError {
    AgentError::new(
        ErrorCode::RevisionConflict,
        format!("REVISION_CONFLICT: Contact changed (currentRevision={current_revision})"),
    )
    .with_details(serde_json::json!({"currentRevision":current_revision}))
}
pub(crate) fn update(
    conn: &Connection,
    id: i64,
    base_revision: u64,
    fields: &ContactFields,
) -> AgentResult<ContactRecord> {
    validate_id(id)?;
    if !(1..=9007199254740991).contains(&base_revision) {
        return Err(invalid("baseRevision must be a positive safe integer"));
    }
    if [
        &fields.name,
        &fields.pinyin_full,
        &fields.pinyin_abbr,
        &fields.email,
        &fields.employee_id,
        &fields.role,
        &fields.department,
        &fields.nicknames,
        &fields.nickname_pinyin,
        &fields.notes,
    ]
    .iter()
    .all(|v| v.is_none())
    {
        return Err(invalid("Contact update requires at least one field"));
    }
    let current = get(conn, id)?;
    if current.revision != base_revision {
        return Err(conflict(current.revision));
    }
    let mut next = current.clone();
    apply(&mut next, fields)?;
    let changed = strings(&current) != strings(&next);
    if changed {
        next.updated_at = now_iso();
    }
    // CAS is enforced by the write itself, including no-op patches.
    let result=conn.query_row(&format!("UPDATE contacts SET name=?1,pinyin_full=?2,pinyin_abbr=?3,email=?4,employee_id=?5,role=?6,department=?7,nicknames=?8,notes=?9,nickname_pinyin=?10,revision=revision+?11,updated_at=?12 WHERE id=?13 AND revision=?14 RETURNING {COLUMNS}"),
        params![next.name,next.pinyin_full,next.pinyin_abbr,next.email,next.employee_id,next.role,next.department,next.nicknames,next.notes,next.nickname_pinyin,i64::from(changed),next.updated_at,id,base_revision as i64],map)
        .optional().map_err(storage)?;
    result.ok_or_else(|| match get(conn, id) {
        Ok(current) => conflict(current.revision),
        Err(error) => error,
    })
}
impl Database {
    pub(super) fn ensure_contacts_schema(&mut self) -> anyhow::Result<()> {
        // ALTER only the small address-book schema. Existing rows retain IDs and timestamps.
        let mut additions = Vec::new();
        for (name, definition) in [
            ("nicknames", "TEXT NOT NULL DEFAULT ''"),
            ("notes", "TEXT NOT NULL DEFAULT ''"),
            ("nickname_pinyin", "TEXT NOT NULL DEFAULT ''"),
            ("revision", "INTEGER NOT NULL DEFAULT 1 CHECK(revision>0)"),
        ] {
            if !self.has_column("contacts", name)? {
                additions.push(format!(
                    "ALTER TABLE contacts ADD COLUMN {name} {definition}"
                ));
            }
        }
        let tx = self.conn.transaction()?;
        for sql in additions {
            tx.execute_batch(&sql)?;
        }
        tx.pragma_update(None, "user_version", super::CURRENT_SCHEMA_VERSION)?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn contact_cli_list(
        &self,
        query: &str,
        limit: usize,
        offset: usize,
    ) -> AgentResult<ContactPage> {
        search(&self.conn, query, limit, offset)
    }
    pub(crate) fn contact_cli_get(&self, id: i64) -> AgentResult<ContactRecord> {
        get(&self.conn, id)
    }
    pub fn contact_list(&self) -> anyhow::Result<Vec<ContactRecord>> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {COLUMNS} FROM contacts ORDER BY created_at DESC,id DESC"
        ))?;
        let rows = statement.query_map([], map)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
    pub fn contact_search(&self, input: ContactSearchInput) -> anyhow::Result<Vec<ContactRecord>> {
        Ok(search(
            &self.conn,
            &input.query,
            input.limit.unwrap_or(20).clamp(1, 100) as usize,
            0,
        )
        .map_err(legacy)?
        .items)
    }
    pub fn contact_upsert(&mut self, input: ContactUpsertInput) -> anyhow::Result<ContactRecord> {
        let name = validate_contact_name(&input.name)?;
        let full = derive_contact_search_text(&name);
        let fields = ContactFields {
            name: Some(name),
            pinyin_full: Some(normalize_contact_pinyin(
                input.pinyin_full.as_deref(),
                &full,
                "pinyinFull",
            )?),
            pinyin_abbr: Some(normalize_contact_pinyin(
                input.pinyin_abbr.as_deref(),
                &derive_contact_search_abbr(&full),
                "pinyinAbbr",
            )?),
            email: Some(input.email.unwrap_or_default()),
            employee_id: Some(input.employee_id.unwrap_or_default()),
            role: Some(input.role.unwrap_or_default()),
            department: Some(input.department.unwrap_or_default()),
            nicknames: input.nicknames,
            nickname_pinyin: input.nickname_pinyin,
            notes: input.notes,
        };
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let contact = match input.id {
            Some(id) => {
                let revision = match input.base_revision {
                    Some(value) => value,
                    None => get(&tx, id).map_err(legacy)?.revision,
                };
                update(&tx, id, revision, &fields).map_err(legacy)?
            }
            None => create(&tx, &fields).map_err(legacy)?,
        };
        tx.commit()?;
        Ok(contact)
    }
    pub fn contact_delete(&mut self, input: ContactDeleteInput) -> anyhow::Result<ContactRecord> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let contact = get(&tx, input.contact_id).map_err(legacy)?;
        tx.execute("DELETE FROM contacts WHERE id=?1", [contact.id])?;
        tx.commit()?;
        Ok(contact)
    }
}

#[cfg(test)]
#[path = "contacts_tests.rs"]
mod tests;
