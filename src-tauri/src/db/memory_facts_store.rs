use super::*;
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
type R<T> = Result<T, String>;
fn sql(e: rusqlite::Error) -> String {
    format!("Memory persistence failed: {e}")
}
fn encode(v: &impl Serialize) -> R<String> {
    serde_json::to_string(v).map_err(|e| e.to_string())
}
fn parse(s: String) -> R<Value> {
    serde_json::from_str(&s).map_err(|e| e.to_string())
}
fn id() -> String {
    format!("mem-{:032x}", rand::random::<u128>())
}
fn now() -> String {
    Utc::now().to_rfc3339()
}
fn key(s: &MemoryScope) -> String {
    match s {
        MemoryScope::Workspace => "workspace".into(),
        MemoryScope::Project { project_id } => format!("project:{project_id}"),
    }
}
fn scope(v: &Value) -> R<MemoryScope> {
    serde_json::from_value(v.clone()).map_err(|_| "Invalid memory scope".into())
}
fn authorize(c: &Connection, a: &MemoryAccess, s: &MemoryScope) -> R<()> {
    if let MemoryScope::Project { project_id } = s {
        if *project_id <= 0
            || !c
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
                    [project_id],
                    |r| r.get::<_, bool>(0),
                )
                .map_err(sql)?
        {
            return Err("Project does not exist".into());
        }
    }
    match (&a.scope, s) {
        (_, MemoryScope::Workspace) => Ok(()),
        (MemoryScope::Project { project_id: a }, MemoryScope::Project { project_id: b })
            if a == b =>
        {
            Ok(())
        }
        _ => Err("Memory scope denied".into()),
    }
}
fn fact(c: &Connection, id: &str) -> R<Value> {
    let s:Option<String>=c.query_row("SELECT v.body FROM memory_fact_heads h JOIN memory_fact_versions v ON v.fact_id=h.id AND v.revision=h.revision WHERE h.id=?1",[id],|r|r.get(0)).optional().map_err(sql)?;
    s.map(parse)
        .transpose()?
        .ok_or_else(|| "Memory fact not found".into())
}
fn facts(c: &Connection) -> R<Vec<Value>> {
    let mut q=c.prepare("SELECT v.body FROM memory_fact_heads h JOIN memory_fact_versions v ON v.fact_id=h.id AND v.revision=h.revision ORDER BY h.id").map_err(sql)?;
    let rows = q.query_map([], |r| r.get::<_, String>(0)).map_err(sql)?;
    rows.map(|r| parse(r.map_err(sql)?)).collect()
}
fn write(c: &Connection, f: &Value, op: &str) -> R<()> {
    let fid = f["id"].as_str().unwrap();
    let revision = f["revision"].as_i64().unwrap();
    c.execute(
        "INSERT INTO memory_fact_versions(fact_id,revision,operation_id,body) VALUES(?1,?2,?3,?4)",
        params![fid, revision, op, encode(f)?],
    )
    .map_err(sql)?;
    c.execute("INSERT INTO memory_fact_heads(id,scope,revision) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",params![fid,key(&scope(&f["scope"])?),revision]).map_err(sql)?;
    // Proposal CAS dependencies include both the survivor and merge sources.
    // This runs in the same transaction as every write, including rollback.
    c.execute(r#"UPDATE memory_fact_proposals SET status='obsolete' WHERE status='pending' AND EXISTS(
        SELECT 1 FROM json_each(memory_fact_proposals.changes_json) AS change
        WHERE (json_extract(change.value,'$.id')=?1 AND json_extract(change.value,'$.expectedRevision')!=?2)
        OR EXISTS(SELECT 1 FROM json_each(json_extract(change.value,'$.from')) AS member
            WHERE json_extract(member.value,'$.id')=?1 AND json_extract(member.value,'$.expectedRevision')!=?2))"#,
        params![fid,revision]).map_err(sql)?;
    Ok(())
}
fn settings(c: &Connection) -> R<Value> {
    let n: bool = c
        .query_row(
            "SELECT require_approval FROM memory_fact_settings WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(sql)?;
    Ok(json!({"requireApproval":n}))
}
fn visible(_a: &MemoryAccess, s: &MemoryScope, f: &Value) -> bool {
    let Ok(fs) = scope(&f["scope"]) else {
        return false;
    };
    fs == *s || (matches!(s, MemoryScope::Project { .. }) && fs == MemoryScope::Workspace)
}
/// Conclusion authorization does not grant access to every original source.
/// Keep the stored source union intact while projecting only permitted evidence.
fn project_fact(a: &MemoryAccess, fact: &mut Value) {
    if let Some(sources) = fact.get_mut("sources").and_then(Value::as_array_mut) {
        sources.retain(|source| match scope(&source["scope"]) {
            Ok(s) => s == a.scope,
            Err(_) => false,
        });
    }
}
pub(super) fn project_result(a: &MemoryAccess, mut out: Value) -> Value {
    if let Some(facts) = out.get_mut("facts").and_then(Value::as_array_mut) {
        for fact in facts {
            project_fact(a, fact);
        }
    }
    out
}
fn valid_at(f: &Value, t: DateTime<Utc>) -> bool {
    for (field, lower) in [("validFrom", true), ("validTo", false)] {
        if let Some(s) = f[field].as_str() {
            let Ok(d) = DateTime::parse_from_rfc3339(s) else {
                return false;
            };
            if (lower && t < d) || (!lower && t >= d) {
                return false;
            }
        }
    }
    true
}
fn validate_fields(f: &Value) -> R<()> {
    if f["content"]
        .as_str()
        .is_none_or(|s| s.trim().is_empty() || s.chars().count() > 8000)
    {
        return Err("Memory content must contain 1–8000 characters".into());
    }
    if f["condition"]
        .as_str()
        .is_some_and(|s| s.chars().count() > 2000)
    {
        return Err("Memory condition is too long".into());
    }
    if !(f["condition"].is_null() || f["condition"].is_string()) || !f["core"].is_boolean() {
        return Err("Invalid condition or core".into());
    }
    let mut times = Vec::new();
    for field in ["validFrom", "validTo"] {
        times.push(if f[field].is_null() {
            None
        } else {
            Some(
                DateTime::parse_from_rfc3339(
                    f[field].as_str().ok_or("Invalid validity timestamp")?,
                )
                .map_err(|_| "Invalid validity timestamp")?,
            )
        })
    }
    if let (Some(start), Some(end)) = (times[0], times[1]) {
        if start >= end {
            return Err("Memory validity window is empty".into());
        }
    }
    Ok(())
}
fn check_change_shape(ch: &Value) -> R<()> {
    let obj = ch.as_object().ok_or("Invalid memory change")?;
    let action = ch["action"].as_str().ok_or("Missing change action")?;
    let mut allowed = vec!["action", "scope"];
    match action {
        "add" => allowed.extend([
            "content",
            "category",
            "condition",
            "core",
            "validFrom",
            "validTo",
        ]),
        "patch" => allowed.extend([
            "id",
            "expectedRevision",
            "content",
            "condition",
            "core",
            "validFrom",
            "validTo",
        ]),
        "merge" => allowed.extend(["id", "expectedRevision", "content", "condition", "from"]),
        "forget" | "disable" | "enable" => allowed.extend(["id", "expectedRevision"]),
        _ => return Err("Invalid memory action".into()),
    };
    if obj.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err("Unknown memory change field".into());
    }
    Ok(())
}
fn target(c: &Connection, a: &MemoryAccess, ch: &Value) -> R<Value> {
    let s = scope(&ch["scope"])?;
    authorize(c, a, &s)?;
    let f = fact(c, ch["id"].as_str().ok_or("Missing fact id")?)?;
    if scope(&f["scope"])? != s {
        return Err("Fact belongs to a different scope".into());
    }
    if ch["expectedRevision"].as_i64() != f["revision"].as_i64() {
        return Err("Memory revision conflict".into());
    }
    if a.origin == MemoryOrigin::Organization && (f["locked"] == true || f["state"] != "active") {
        return Err("Organization cannot mutate a protected fact".into());
    }
    if f["state"] == "forgotten" || f["state"] == "superseded" {
        return Err("Fact cannot be changed in its current state".into());
    }
    Ok(f)
}
fn suppression_key(f: &Value) -> String {
    // The durable negative constraint belongs to the conclusion, never an entire
    // source message. Changing / losing evidence cannot resurrect that conclusion;
    // independent conclusions in the same message retain their own identities.
    let content = f["content"]
        .as_str()
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    format!(
        "{:x}",
        Sha256::digest(
            encode(&json!([f["scope"], content, f["condition"]]))
                .unwrap()
                .as_bytes()
        )
    )
}
fn suppression(c: &Connection, f: &Value) -> R<()> {
    let sk = suppression_key(f);
    c.execute("INSERT INTO memory_fact_suppressions(id,scope,body,identity) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET body=excluded.body,identity=excluded.identity",params![f["id"].as_str(),key(&scope(&f["scope"])?),encode(&json!({"id":f["id"],"scope":f["scope"],"content":f["content"],"condition":f["condition"]}))?,sk]).map_err(sql)?;
    Ok(())
}
fn apply(c: &Connection, a: &MemoryAccess, changes: &[Value], op: &str) -> R<Vec<Value>> {
    if changes.is_empty() || changes.len() > 100 {
        return Err("Memory batch must contain 1–100 changes".into());
    }
    let mut changed = Vec::new();
    let mut touched = BTreeSet::new();
    for ch in changes {
        // The receipt covers the atomic batch. Each independent change retains
        // its own undo unit; a merge's survivor and sources share that unit.
        let unit_id = if changes.len() == 1 {
            op.to_owned()
        } else {
            id()
        };
        let op = unit_id.as_str();
        let unit_start = changed.len();
        let mut before = BTreeMap::<String, Value>::new();
        check_change_shape(ch)?;
        let s = scope(&ch["scope"])?;
        authorize(c, a, &s)?;
        let action = ch["action"].as_str().unwrap();
        let mut f = if action == "add" {
            let cat = ch["category"].as_str().ok_or("Missing category")?;
            let cats = match s {
                MemoryScope::Workspace => vec![
                    "background",
                    "domain",
                    "interest",
                    "method",
                    "preference",
                    "knowledge_pointer",
                ],
                MemoryScope::Project { .. } => vec!["agreement", "decision"],
            };
            if !cats.contains(&cat) {
                return Err("Invalid category for memory scope".into());
            }
            let n = id();
            before.insert(n.clone(), Value::Null);
            json!({"id":n,"scope":s,"category":cat,"content":ch["content"],"condition":ch.get("condition").cloned().unwrap_or(Value::Null),"core":ch.get("core").cloned().unwrap_or(json!(false)),"state":"active","confirmation":"inferred","revision":0,"validFrom":ch.get("validFrom").cloned().unwrap_or(Value::Null),"validTo":ch.get("validTo").cloned().unwrap_or(Value::Null),"supersededBy":null,"sources":a.sources,"locked":false,"autoOrganizedAt":null,"rollbackId":null})
        } else {
            let f = target(c, a, ch)?;
            before.insert(f["id"].as_str().unwrap().into(), f.clone());
            f
        };
        let fid = f["id"].as_str().unwrap().to_owned();
        if !touched.insert(fid.clone()) {
            return Err("A fact may appear only once in an atomic batch".into());
        }
        match action {
            "patch" => {
                for k in ["content", "condition", "core", "validFrom", "validTo"] {
                    if let Some(v) = ch.get(k) {
                        f[k] = v.clone()
                    }
                }
            }
            "merge" => {
                f["content"] = ch["content"].clone();
                if let Some(v) = ch.get("condition") {
                    f["condition"] = v.clone()
                };
                let from = ch["from"].as_array().ok_or("Missing merge sources")?;
                if from.is_empty() {
                    return Err("Merge requires source facts".into());
                }
                for item in from {
                    let other = target(
                        c,
                        a,
                        &json!({"id":item["id"],"expectedRevision":item["expectedRevision"],"scope":s}),
                    )?;
                    let oid = other["id"].as_str().unwrap().to_owned();
                    if !touched.insert(oid.clone()) {
                        return Err("Repeated merge member".into());
                    };
                    before.insert(oid, other.clone());
                    let mut superseded = other.clone();
                    superseded["state"] = json!("superseded");
                    superseded["supersededBy"] = json!(fid);
                    finish(&mut superseded, a, op);
                    write(c, &superseded, op)?;
                    changed.push(superseded);
                    for src in other["sources"].as_array().unwrap() {
                        if !f["sources"].as_array().unwrap().contains(src) {
                            f["sources"].as_array_mut().unwrap().push(src.clone());
                        }
                    }
                }
            }
            "forget" => {
                f["state"] = json!("forgotten");
                suppression(c, &f)?
            }
            "disable" => {
                f["state"] = json!("disabled");
                suppression(c, &f)?
            }
            "enable" => {
                if a.origin != MemoryOrigin::User {
                    return Err("Only a user can re-enable memory".into());
                }
                f["state"] = json!("active");
                c.execute("DELETE FROM memory_fact_suppressions WHERE id=?1", [&fid])
                    .map_err(sql)?;
            }
            _ => {}
        }
        for src in &a.sources {
            let v = serde_json::to_value(src).map_err(|e| e.to_string())?;
            if !f["sources"].as_array().unwrap().contains(&v) {
                f["sources"].as_array_mut().unwrap().push(v)
            }
        }
        validate_fields(&f)?;
        let sk = suppression_key(&f);
        if action == "add"
            && a.origin == MemoryOrigin::Organization
            && facts(c)?
                .iter()
                .any(|existing| existing["state"] == "active" && suppression_key(existing) == sk)
        {
            return Err("Memory conclusion already exists; patch its stable fact id".into());
        }
        if f["state"] == "active" {
            let suppressed: bool = c
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM memory_fact_suppressions WHERE identity=?1)",
                    [&sk],
                    |r| r.get(0),
                )
                .map_err(sql)?;
            if suppressed {
                if a.origin == MemoryOrigin::Organization {
                    return Err("This fact is suppressed".into());
                }
                if action == "add" {
                    c.execute(
                        "DELETE FROM memory_fact_suppressions WHERE identity=?1",
                        [sk],
                    )
                    .map_err(sql)?;
                }
            }
        }
        if f["state"] == "disabled" {
            suppression(c, &f)?;
        }
        finish(&mut f, a, op);
        write(c, &f, op)?;
        changed.push(f);
        let after: Vec<Value> = changed[unit_start..]
            .iter()
            .map(|f| json!({"id":f["id"],"revision":f["revision"]}))
            .collect();
        c.execute("INSERT INTO memory_fact_operations(id,created_at,before_json,after_json,undone) VALUES(?1,?2,?3,?4,0)",params![op,now(),encode(&before)?,encode(&after)?]).map_err(sql)?;
    }
    Ok(changed)
}
fn eligible_core(f: &Value) -> bool {
    f["core"] == true
        && f["confirmation"] == "confirmed"
        && f["scope"]["kind"] == "workspace"
        && f["condition"].is_null()
}
fn finish(f: &mut Value, a: &MemoryAccess, op: &str) {
    f["revision"] = json!(f["revision"].as_i64().unwrap() + 1);
    f["confirmation"] = json!(if a.origin == MemoryOrigin::User {
        "confirmed"
    } else {
        "inferred"
    });
    if !eligible_core(f) {
        f["core"] = json!(false);
    }
    if a.origin == MemoryOrigin::Organization {
        f["autoOrganizedAt"] = json!(now());
        f["rollbackId"] = json!(op);
    } else {
        f["autoOrganizedAt"] = Value::Null;
        f["rollbackId"] = Value::Null;
    }
}
fn result(facts: Vec<Value>, receipt: &str, pending: bool, pid: Option<&str>) -> Value {
    json!({"facts":facts,"receipt":receipt,"pending":pending,"proposalId":pid})
}
pub(super) fn schema(c: &Connection) -> R<()> {
    c.execute_batch(r#"
 CREATE TABLE IF NOT EXISTS memory_fact_heads(id TEXT PRIMARY KEY,scope TEXT NOT NULL,revision INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS memory_fact_versions(fact_id TEXT NOT NULL,revision INTEGER NOT NULL,operation_id TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body) AND COALESCE(json_extract(body,'$.state'),'') IN ('active','disabled','forgotten','superseded') AND COALESCE(json_extract(body,'$.confirmation'),'') IN ('confirmed','inferred')),PRIMARY KEY(fact_id,revision));
 CREATE TABLE IF NOT EXISTS memory_fact_operations(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,undone INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS memory_fact_undos(original_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS memory_fact_receipts(request_id TEXT PRIMARY KEY,payload TEXT NOT NULL,result TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS memory_fact_suppressions(id TEXT PRIMARY KEY,scope TEXT NOT NULL,body TEXT NOT NULL,identity TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS memory_fact_proposals(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,access_json TEXT NOT NULL,changes_json TEXT NOT NULL,status TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS memory_fact_settings(id INTEGER PRIMARY KEY CHECK(id=1),require_approval INTEGER NOT NULL);
 INSERT OR IGNORE INTO memory_fact_settings VALUES(1,0);
 "#).map_err(sql)
}
fn rollback(c: &Connection, a: &MemoryAccess, rid: &str, op: &str) -> R<Vec<Value>> {
    if a.origin != MemoryOrigin::User {
        return Err("Only the user may undo organization".into());
    }
    let row:Option<(String,String,String,bool)>=c.query_row("SELECT created_at,before_json,after_json,(undone OR EXISTS(SELECT 1 FROM memory_fact_undos WHERE original_id=memory_fact_operations.id)) FROM memory_fact_operations WHERE id=?1",[rid],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(sql)?;
    let (created, before, after, undone) = row.ok_or("Memory operation not found")?;
    if undone
        || Utc::now()
            - DateTime::parse_from_rfc3339(&created)
                .map_err(|e| e.to_string())?
                .with_timezone(&Utc)
            > Duration::hours(24)
    {
        return Err("Memory undo window expired or already undone".into());
    }
    let before: BTreeMap<String, Value> =
        serde_json::from_str(&before).map_err(|e| e.to_string())?;
    let after: Vec<Value> = serde_json::from_str(&after).map_err(|e| e.to_string())?;
    for f in &after {
        let organized: String = c
            .query_row(
                "SELECT body FROM memory_fact_versions WHERE fact_id=?1 AND revision=?2",
                params![f["id"].as_str(), f["revision"].as_i64()],
                |r| r.get(0),
            )
            .map_err(sql)?;
        if parse(organized)?["rollbackId"].as_str() != Some(rid) {
            return Err("Only automatic organization can be rolled back".into());
        }
        let current = fact(c, f["id"].as_str().unwrap())?;
        authorize(c, a, &scope(&current["scope"])?)?;
        if current["revision"] != f["revision"] {
            return Err("Memory undo conflicts with a later edit".into());
        }
    }
    let mut current_before = BTreeMap::<String, Value>::new();
    let mut restored = Vec::new();
    for (fid, previous) in &before {
        let current = fact(c, fid)?;
        current_before.insert(fid.clone(), current.clone());
        let mut f = if previous.is_null() {
            let mut f = current.clone();
            f["state"] = json!("disabled");
            f
        } else {
            previous.clone()
        };
        f["revision"] = current["revision"].clone();
        // This new version reflects the real user's explicit restoration;
        // the immutable older inferred version retains its original status.
        finish(&mut f, a, op);
        f["locked"] = json!(true);
        if f["state"] == "disabled" || f["state"] == "forgotten" {
            suppression(c, &f)?
        } else {
            c.execute("DELETE FROM memory_fact_suppressions WHERE id=?1", [fid])
                .map_err(sql)?;
        }
        write(c, &f, op)?;
        restored.push(f)
    }
    c.execute(
        "INSERT INTO memory_fact_undos(original_id,operation_id) VALUES(?1,?2)",
        params![rid, op],
    )
    .map_err(sql)?;
    let after: Vec<Value> = restored
        .iter()
        .map(|f| json!({"id":f["id"],"revision":f["revision"]}))
        .collect();
    c.execute("INSERT INTO memory_fact_operations(id,created_at,before_json,after_json,undone) VALUES(?1,?2,?3,?4,1)",params![op,now(),encode(&current_before)?,encode(&after)?]).map_err(sql)?;
    Ok(restored)
}
fn load_proposal(c: &Connection, a: &MemoryAccess, pid: &str) -> R<(MemoryAccess, Vec<Value>)> {
    let p: Option<(String, String, String)> = c
        .query_row(
            "SELECT access_json,changes_json,status FROM memory_fact_proposals WHERE id=?1",
            [pid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(sql)?;
    let (access, changes, status) = p.ok_or("Memory proposal not found")?;
    if status != "pending" {
        return Err("Memory proposal is no longer pending".into());
    }
    let saved: StoredAccess = serde_json::from_str(&access).map_err(|e| e.to_string())?;
    let changes: Vec<Value> = serde_json::from_str(&changes).map_err(|e| e.to_string())?;
    for ch in &changes {
        authorize(c, a, &scope(&ch["scope"])?)?
    }
    Ok((
        MemoryAccess {
            scope: saved.scope,
            origin: MemoryOrigin::Organization,
            sources: saved.sources,
        },
        changes,
    ))
}
#[derive(Serialize, Deserialize)]
struct StoredAccess {
    scope: MemoryScope,
    sources: Vec<MemorySource>,
}
fn proposal_list(c: &Connection, a: &MemoryAccess, s: &MemoryScope) -> R<Vec<Value>> {
    let mut q=c.prepare("SELECT id,created_at,changes_json FROM memory_fact_proposals WHERE status='pending' ORDER BY created_at,id").map_err(sql)?;
    let rows = q
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(sql)?;
    let mut out = Vec::new();
    for row in rows {
        let (id, t, changes) = row.map_err(sql)?;
        let changes: Vec<Value> = serde_json::from_str(&changes).map_err(|e| e.to_string())?; // Never disclose another Project through a mixed proposal.
        if changes.iter().all(|ch| visible(a, s, ch)) {
            out.push(json!({"id":id,"createdAt":t,"changes":changes}));
        }
    }
    Ok(out)
}
fn lexical_score(query: &str, f: &Value) -> usize {
    let q: Vec<char> = query
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect();
    let text = format!(
        "{} {}",
        f["content"].as_str().unwrap_or(""),
        f["condition"].as_str().unwrap_or("")
    )
    .to_lowercase();
    let mut score = 0;
    for ch in &q {
        if text.contains(*ch) {
            score += 1
        }
    }
    for pair in q.windows(2) {
        if text.contains(&pair.iter().collect::<String>()) {
            score += 4
        }
    }
    score
}
fn context(
    c: &Connection,
    a: &MemoryAccess,
    s: &MemoryScope,
    query: &str,
    budget: usize,
    strategy: &str,
) -> R<Value> {
    if !["snapshot", "layered"].contains(&strategy) || budget > 100_000 {
        return Err("Invalid memory context strategy or budget".into());
    }
    let mut eligible: Vec<Value> = facts(c)?
        .into_iter()
        .filter(|f| visible(a, s, f) && f["state"] == "active" && valid_at(f, Utc::now()))
        .collect();
    if strategy == "layered" {
        eligible.sort_by_key(|f| std::cmp::Reverse((eligible_core(f), lexical_score(query, f))));
    } else {
        eligible.sort_by_key(|f| std::cmp::Reverse(eligible_core(f)));
    }
    let mut selected = Vec::new();
    let mut omitted = Vec::new();
    let mut used = 0;
    for mut f in eligible {
        if strategy == "layered"
            && !query.trim().is_empty()
            && !eligible_core(&f)
            && lexical_score(query, &f) == 0
        {
            omitted.push(f["id"].clone());
            continue;
        }
        // L1/L2 retain conclusions and applicability only. Original evidence
        // is returned exclusively by the separately authorized L3 read.
        f["sources"] = json!([]);
        if !eligible_core(&f) {
            f["core"] = json!(false);
        }
        let cost = encode(&f)?.chars().count() + 1;
        if used + cost <= budget {
            used += cost;
            selected.push(f)
        } else {
            omitted.push(f["id"].clone())
        }
    }
    let mut q = c
        .prepare("SELECT body FROM memory_fact_suppressions ORDER BY id")
        .map_err(sql)?;
    let rows = q.query_map([], |r| r.get::<_, String>(0)).map_err(sql)?;
    let mut suppressed = Vec::new();
    for row in rows {
        let f = parse(row.map_err(sql)?)?;
        if visible(a, s, &f) {
            suppressed.push(f)
        }
    }
    Ok(json!({"facts":selected,"omittedIds":omitted,"suppressed":suppressed}))
}
pub(super) fn execute(db: &Database, a: &MemoryAccess, r: MemoryRequest) -> R<Value> {
    let c = &db.conn;
    authorize(c, a, &a.scope)?;
    if a.sources.len() > 128 || encode(&json!({"request":r,"access":a}))?.len() > 1024 * 1024 {
        return Err("Memory request exceeds its resource budget".into());
    }
    for src in &a.sources {
        authorize(c, a, &src.scope)?;
        if !["message", "record", "file"].contains(&src.kind.as_str()) || src.id.is_empty() {
            return Err("Invalid trusted memory evidence".into());
        }
    }
    match &r {
        MemoryRequest::List {
            scope: s,
            include_inactive,
        } => {
            let read =
                rusqlite::Transaction::new_unchecked(c, rusqlite::TransactionBehavior::Deferred)
                    .map_err(sql)?;
            authorize(&read, a, &a.scope)?;
            authorize(&read, a, s)?;
            return Ok(
                json!({"facts":facts(&read)?.into_iter().filter(|f|visible(a,s,f)&&(*include_inactive||f["state"]=="active")).collect::<Vec<_>>(),"proposals":proposal_list(&read,a,s)?,"settings":settings(&read)?}),
            );
        }
        MemoryRequest::Context {
            scope: s,
            query,
            budget_chars,
            strategy,
        } => {
            let read =
                rusqlite::Transaction::new_unchecked(c, rusqlite::TransactionBehavior::Deferred)
                    .map_err(sql)?;
            authorize(&read, a, &a.scope)?;
            authorize(&read, a, s)?;
            return context(&read, a, s, query, *budget_chars, strategy);
        }
        _ => {}
    }
    // IMMEDIATE prevents the CAS / receipt check from racing another connection.
    let tx = rusqlite::Transaction::new_unchecked(c, rusqlite::TransactionBehavior::Immediate)
        .map_err(sql)?;
    authorize(&tx, a, &a.scope)?;
    let request_id = match &r {
        MemoryRequest::Apply { request_id, .. }
        | MemoryRequest::Rollback { request_id, .. }
        | MemoryRequest::Approve { request_id, .. }
        | MemoryRequest::Reject { request_id, .. } => Some(request_id.clone()),
        _ => None,
    };
    let payload = encode(&json!({"request":r,"access":a}))?;
    if let Some(rid) = &request_id {
        if rid.is_empty() || rid.len() > 512 {
            return Err("Invalid memory request id".into());
        }
        let old: Option<(String, String)> = tx
            .query_row(
                "SELECT payload,result FROM memory_fact_receipts WHERE request_id=?1",
                [rid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(sql)?;
        if let Some((p, out)) = old {
            if p != payload {
                return Err("Memory idempotency payload conflict".into());
            }
            return parse(out);
        }
    }
    let op = id();
    let out = match r {
        MemoryRequest::Settings { require_approval } => {
            if a.origin != MemoryOrigin::User {
                return Err("Only the user may change organization settings".into());
            }
            tx.execute(
                "UPDATE memory_fact_settings SET require_approval=?1 WHERE id=1",
                [require_approval],
            )
            .map_err(sql)?;
            settings(&tx)?
        }
        MemoryRequest::Apply { changes, .. } => {
            if a.origin == MemoryOrigin::Organization && settings(&tx)?["requireApproval"] == true {
                // Validate on a savepoint, then remove all projected facts/versions before persisting the proposal.
                tx.execute_batch("SAVEPOINT memory_proposal_validation")
                    .map_err(sql)?;
                let checked = apply(&tx, a, &changes, &op);
                tx.execute_batch(
                    "ROLLBACK TO memory_proposal_validation; RELEASE memory_proposal_validation",
                )
                .map_err(sql)?;
                checked?;
                let pid = id();
                tx.execute("INSERT INTO memory_fact_proposals(id,created_at,access_json,changes_json,status) VALUES(?1,?2,?3,?4,'pending')",params![pid,now(),encode(&StoredAccess{scope:a.scope.clone(),sources:a.sources.clone()})?,encode(&changes)?]).map_err(sql)?;
                result(vec![], &op, true, Some(&pid))
            } else {
                result(apply(&tx, a, &changes, &op)?, &op, false, None)
            }
        }
        MemoryRequest::Rollback { rollback_id, .. } => {
            result(rollback(&tx, a, &rollback_id, &op)?, &op, false, None)
        }
        MemoryRequest::Approve { proposal_id, .. } => {
            if a.origin != MemoryOrigin::User {
                return Err("Only the user may approve proposals".into());
            }
            let (original, changes) = load_proposal(&tx, a, &proposal_id)?;
            let fs = apply(&tx, &original, &changes, &op)?;
            tx.execute(
                "UPDATE memory_fact_proposals SET status='approved' WHERE id=?1",
                [proposal_id],
            )
            .map_err(sql)?;
            result(fs, &op, false, None)
        }
        MemoryRequest::Reject { proposal_id, .. } => {
            if a.origin != MemoryOrigin::User {
                return Err("Only the user may reject proposals".into());
            }
            load_proposal(&tx, a, &proposal_id)?;
            tx.execute(
                "UPDATE memory_fact_proposals SET status='rejected' WHERE id=?1",
                [proposal_id],
            )
            .map_err(sql)?;
            result(vec![], &op, false, None)
        }
        _ => unreachable!(),
    };
    if let Some(rid) = request_id {
        tx.execute(
            "INSERT INTO memory_fact_receipts(request_id,payload,result) VALUES(?1,?2,?3)",
            params![rid, payload, encode(&out)?],
        )
        .map_err(sql)?;
    }
    tx.commit().map_err(sql)?;
    Ok(out)
}
