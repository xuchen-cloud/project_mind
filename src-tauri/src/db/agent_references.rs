//! Current native internal links. No file bytes or derived search index are read.
use super::{agent_operations::io_error, Database};
use crate::agent::{
    access::RequestContext,
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, Scope, WorkspaceBinding},
    references::{ReferenceDirection, ReferenceItem, ReferenceListInput, ReferenceListPage},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const MAX_CANDIDATES: usize = 100;
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

fn error(code: ErrorCode, message: &'static str) -> AgentError { AgentError::new(code, message) }
fn invalid() -> AgentError { error(ErrorCode::InvalidArgument, "Invalid reference list input") }
fn changed() -> AgentError { error(ErrorCode::SourceChanged, "Reference list changed; start again") }
fn too_large() -> AgentError { error(ErrorCode::BudgetExceeded, "Reference source exceeds this page's processing budget") }
fn expected_hidden(error: &AgentError) -> bool {
    matches!(error.code, ErrorCode::ScopeDenied | ErrorCode::NotFound | ErrorCode::ObjectWithdrawn)
}
fn supported(kind: ObjectKind) -> bool {
    matches!(kind, ObjectKind::Record | ObjectKind::Todo | ObjectKind::File | ObjectKind::QuickNote)
}
fn link_kind(object: &ObjectRef) -> Option<&'static str> {
    match (&object.kind, &object.scope) {
        (ObjectKind::Record, Scope::Workspace) => Some("workspace_record"),
        (ObjectKind::Record, Scope::Project { .. }) => Some("note"),
        (ObjectKind::Todo, _) => Some("todo"),
        (ObjectKind::File, _) => Some("document"),
        _ => None,
    }
}
fn scope_hash(request: &RequestContext) -> AgentResult<String> {
    let bytes = serde_json::to_vec(&json!({
        "binding":request.binding,"caller":request.caller.key(),
        "workspaceId":request.scope_grant.workspace_id,
        "workspaceContent":request.scope_grant.workspace_content,
        "projectIds":request.scope_grant.project_ids,
        "operations":request.scope_grant.operations,
        "objectKeys":request.scope_grant.object_keys,
    })).map_err(|_| error(ErrorCode::IoFailed, "Cannot encode reference scope"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    object_key: String,
    direction: ReferenceDirection,
    grant_hash: String,
    snapshot_seq: i64,
    last_visible_key: Option<String>,
}
fn encode_cursor(cursor: &Cursor) -> AgentResult<String> {
    let bytes = serde_json::to_vec(cursor).map_err(|_| error(ErrorCode::IoFailed, "Cannot encode reference cursor"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn decode_cursor(raw: &str) -> AgentResult<Cursor> {
    if raw.len() > 2048 { return Err(invalid()); }
    let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| invalid())?;
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}
fn title(db: &Database, object: &ObjectRef) -> AgentResult<String> {
    let id = object.id.parse::<i64>().map_err(|_| invalid())?;
    let text: Option<String> = match (&object.kind, &object.scope) {
        (ObjectKind::Record, Scope::Project { .. }) => db.conn.query_row("SELECT substr(title,1,120) FROM agent_visible_notes WHERE id=?1",[id],|r|r.get(0)).optional().map_err(io_error)?.flatten(),
        (ObjectKind::Record, Scope::Workspace) => db.conn.query_row("SELECT substr(title,1,120) FROM agent_visible_workspace_notes WHERE id=?1 AND note_kind='workspace_note'",[id],|r|r.get(0)).optional().map_err(io_error)?.flatten(),
        (ObjectKind::Todo, _) => db.conn.query_row("SELECT substr(content,1,120) FROM agent_visible_todos WHERE id=?1",[id],|r|r.get(0)).optional().map_err(io_error)?,
        (ObjectKind::File, _) => db.conn.query_row("SELECT substr(name,1,120) FROM agent_visible_files WHERE id=?1",[id],|r|r.get(0)).optional().map_err(io_error)?,
        (ObjectKind::QuickNote, Scope::Project { .. }) => db.conn.query_row("SELECT substr(name,1,120) FROM projects WHERE id=?1",[id],|r|r.get(0)).optional().map_err(io_error)?,
        (ObjectKind::QuickNote, Scope::Workspace) => Some("QuickNote".into()),
        _ => None,
    };
    let fallback = match object.kind { ObjectKind::Record => "Record", ObjectKind::Todo => "Todo", ObjectKind::File => "File", _ => "QuickNote" };
    Ok(text.as_deref().filter(|s| !s.trim().is_empty()).unwrap_or(fallback).chars().take(120).collect())
}

// SQL scopes and current visibility are applied before parsing old text. The
// numeric probe keeps + and leading-zero candidates for native parsing.
const VISIBLE: &str = r#"
WITH source(key,body,kind,id) AS (
 SELECT ?1||'/project:'||n.project_id||'/record/'||n.id,n.content_markdown,'record',n.id
 FROM agent_visible_notes n JOIN projects p ON p.id=n.project_id AND p.is_archived=0
 WHERE EXISTS(SELECT 1 FROM json_each(?2) g WHERE g.value=n.project_id)
 UNION ALL SELECT ?1||'/workspace/record/'||w.id,w.content_markdown,'record',w.id
 FROM agent_visible_workspace_notes w WHERE ?3=1 AND w.note_kind='workspace_note'
 UNION ALL SELECT ?1||'/project:'||p.id||'/quick_note/'||p.id,p.summary_markdown,'quick_note',p.id
 FROM projects p WHERE p.is_archived=0 AND EXISTS(SELECT 1 FROM json_each(?2) g WHERE g.value=p.id)
 UNION ALL SELECT ?1||'/workspace/quick_note/'||w.id,w.content_markdown,'quick_note',w.id
 FROM workspace_notes w WHERE ?3=1 AND w.note_kind='today_quick_note'
 UNION ALL SELECT ?1||'/'||(CASE WHEN t.scope='workspace' THEN 'workspace' ELSE 'project:'||t.project_id END)||'/todo/'||t.id,t.content,'todo',t.id
 FROM agent_visible_todos t LEFT JOIN projects p ON p.id=t.project_id
 WHERE (t.scope='workspace' AND ?3=1) OR (t.scope='project' AND p.is_archived=0 AND EXISTS(SELECT 1 FROM json_each(?2) g WHERE g.value=t.project_id))
 UNION ALL SELECT ?1||'/project:'||f.project_id||'/file/'||f.id,'','file',f.id
 FROM agent_visible_files f JOIN projects p ON p.id=f.project_id AND p.is_archived=0
 WHERE f.storage_mode!='managed_note_image' AND EXISTS(SELECT 1 FROM json_each(?2) g WHERE g.value=f.project_id)
), visible AS (
 SELECT s.key,s.body,s.kind,s.id FROM source s
 WHERE (?8 IS NULL OR s.key IN (SELECT value FROM json_each(?8)))
   AND NOT EXISTS(SELECT 1 FROM source_access_policies x WHERE x.object_key=s.key AND x.excluded=1)
)
"#;
const INCOMING: &str = r#"
SELECT DISTINCT s.key FROM visible s
WHERE s.key>?6 AND (EXISTS(SELECT 1 FROM content_reference_edges e WHERE e.source_object_key=s.key AND e.target_object_key=?4 AND e.relation='internal_reference')
 OR (?5!='' AND (s.kind!='record' OR NOT EXISTS(SELECT 1 FROM record_document_heads h WHERE h.record_key=replace(substr(s.key,length(?1)+2),'/record/',':')))
 AND ((instr(s.body,'[['||?5||':'||?7||'|')>0 OR instr(s.body,'[['||?5||':+'||?7||'|')>0 OR instr(s.body,'[['||?5||':0')>0 OR instr(s.body,'[['||?5||':+0')>0)
 OR (s.kind='todo' AND EXISTS(SELECT 1 FROM todo_progresses tp WHERE tp.todo_id=s.id AND
 (instr(tp.content,'[['||?5||':'||?7||'|')>0 OR instr(tp.content,'[['||?5||':+'||?7||'|')>0 OR instr(tp.content,'[['||?5||':0')>0 OR instr(tp.content,'[['||?5||':+0')>0))))))
ORDER BY s.key LIMIT 101
"#;
const OUTGOING: &str = r#"
SELECT DISTINCT v.key FROM visible v
WHERE v.key>?6 AND (EXISTS(SELECT 1 FROM content_reference_edges e WHERE e.source_object_key=?4 AND e.target_object_key=v.key AND e.relation='internal_reference')
 OR EXISTS(SELECT 1 FROM json_each(?5) old WHERE old.value=v.key))
ORDER BY v.key LIMIT 101
"#;

impl Database {
    fn reference_texts(&self, object: &ObjectRef, remaining: &mut usize) -> AgentResult<Option<Vec<String>>> {
        let id = object.id.parse::<i64>().map_err(|_| invalid())?;
        let mut texts = Vec::new();
        let sql = match (&object.kind, &object.scope) {
            (ObjectKind::Record, Scope::Project { .. }) => {
                let key = crate::record_documents::RecordTarget { scope:object.scope.clone(),record_id:id }.key()?;
                let has_head: bool = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM record_document_heads WHERE record_key=?1)",[key],|r|r.get(0)).map_err(io_error)?;
                if has_head { return Ok(Some(texts)); }
                "SELECT content_markdown FROM agent_visible_notes WHERE id=?1"
            }
            (ObjectKind::Record, Scope::Workspace) => {
                let key = crate::record_documents::RecordTarget { scope:object.scope.clone(),record_id:id }.key()?;
                let has_head: bool = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM record_document_heads WHERE record_key=?1)",[key],|r|r.get(0)).map_err(io_error)?;
                if has_head { return Ok(Some(texts)); }
                "SELECT content_markdown FROM agent_visible_workspace_notes WHERE id=?1 AND note_kind='workspace_note'"
            }
            (ObjectKind::QuickNote, Scope::Project { .. }) => "SELECT summary_markdown FROM projects WHERE id=?1",
            (ObjectKind::QuickNote, Scope::Workspace) => "SELECT content_markdown FROM workspace_notes WHERE id=?1 AND note_kind='today_quick_note'",
            (ObjectKind::Todo, _) => "SELECT content FROM agent_visible_todos WHERE id=?1",
            _ => return Ok(Some(texts)),
        };
        let byte_sql = match (&object.kind,&object.scope) {
            (ObjectKind::Record,Scope::Project { .. }) => "SELECT length(CAST(content_markdown AS BLOB)) FROM agent_visible_notes WHERE id=?1",
            (ObjectKind::Record,Scope::Workspace) => "SELECT length(CAST(content_markdown AS BLOB)) FROM agent_visible_workspace_notes WHERE id=?1 AND note_kind='workspace_note'",
            (ObjectKind::QuickNote,Scope::Project { .. }) => "SELECT length(CAST(summary_markdown AS BLOB)) FROM projects WHERE id=?1",
            (ObjectKind::QuickNote,Scope::Workspace) => "SELECT length(CAST(content_markdown AS BLOB)) FROM workspace_notes WHERE id=?1 AND note_kind='today_quick_note'",
            (ObjectKind::Todo,_) => "SELECT length(CAST(t.content AS BLOB))+COALESCE((SELECT sum(length(CAST(p.content AS BLOB))) FROM todo_progresses p WHERE p.todo_id=t.id),0) FROM agent_visible_todos t WHERE t.id=?1",
            _ => unreachable!(),
        };
        let bytes: i64 = self.conn.query_row(byte_sql,[id],|r|r.get(0)).optional().map_err(io_error)?.unwrap_or(0);
        if bytes<0 || bytes as usize>MAX_BODY_BYTES { return Err(too_large()); }
        if bytes as usize>*remaining { return Ok(None); }
        *remaining-=bytes as usize;
        if let Some(body) = self.conn.query_row(sql,[id],|r|r.get::<_,String>(0)).optional().map_err(io_error)? { texts.push(body); }
        if object.kind == ObjectKind::Todo {
            let mut statement = self.conn.prepare("SELECT content FROM todo_progresses WHERE todo_id=?1 ORDER BY id").map_err(io_error)?;
            for row in statement.query_map([id],|r|r.get::<_,String>(0)).map_err(io_error)? { texts.push(row.map_err(io_error)?); }
        }
        Ok(Some(texts))
    }
    fn incoming_candidates(&self, request: &RequestContext, object: &ObjectRef, after: &str) -> AgentResult<Vec<String>> {
        let projects = serde_json::to_string(&request.scope_grant.project_ids).map_err(|_| invalid())?;
        let allowed_keys = request.scope_grant.object_keys.as_ref().map(serde_json::to_string).transpose().map_err(|_| invalid())?;
        let sql = format!("{VISIBLE}{INCOMING}");
        let mut statement = self.conn.prepare(&sql).map_err(io_error)?;
        let rows = statement.query_map(params![object.workspace_id,projects,request.scope_grant.workspace_content,object.key()?,link_kind(object).unwrap_or(""),after,object.id,allowed_keys],|r|r.get(0)).map_err(io_error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(io_error)
    }
    fn outgoing_candidates(&self, request: &RequestContext, object: &ObjectRef, after: &str, remaining: &mut usize) -> AgentResult<Vec<String>> {
        let mut legacy = BTreeSet::new();
        for text in self.reference_texts(object,remaining)?.ok_or_else(too_large)? {
            for (kind,id) in super::parse_internal_reference_tokens(&text) {
                if id <= 0 { continue; }
                if let Some(target) = super::record_references::resolve_reference_object(&self.conn,&kind,id,&object.workspace_id)? {
                    legacy.insert(target.key()?);
                }
            }
        }
        let keys = serde_json::to_string(&legacy).map_err(|_| invalid())?;
        let projects = serde_json::to_string(&request.scope_grant.project_ids).map_err(|_| invalid())?;
        let allowed_keys = request.scope_grant.object_keys.as_ref().map(serde_json::to_string).transpose().map_err(|_| invalid())?;
        let sql = format!("{VISIBLE}{OUTGOING}");
        let mut statement = self.conn.prepare(&sql).map_err(io_error)?;
        let rows = statement.query_map(params![object.workspace_id,projects,request.scope_grant.workspace_content,object.key()?,keys,after,rusqlite::types::Null,allowed_keys],|r|r.get(0)).map_err(io_error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(io_error)
    }
    pub fn agent_reference_list(&self, request: &RequestContext, binding: &WorkspaceBinding, input: &ReferenceListInput) -> AgentResult<ReferenceListPage> {
        if !supported(input.object.kind) { return Err(error(ErrorCode::ToolCallUnsupported, "Reference kind is unsupported")); }
        let limit = input.limit.unwrap_or(20);
        let budget = input.budget_chars.unwrap_or(4000);
        if !(1..=50).contains(&limit) || !(1..=12000).contains(&budget) { return Err(invalid()); }
        let object = self.source_read_object(request,binding,&input.object)?;
        let object_key = object.key()?;
        let grant_hash = scope_hash(request)?;
        let snapshot_seq: i64 = self.conn.query_row(
            "SELECT MAX(COALESCE((SELECT MAX(seq) FROM agent_change_log),0),COALESCE((SELECT seq FROM sqlite_sequence WHERE name='agent_change_log'),0))",
            [],|r|r.get(0),
        ).map_err(io_error)?;
        let mut cursor = if let Some(raw) = &input.cursor { decode_cursor(raw)? } else {
            Cursor { object_key:object_key.clone(),direction:input.direction,grant_hash:grant_hash.clone(),snapshot_seq,last_visible_key:None }
        };
        if cursor.object_key!=object_key || cursor.direction!=input.direction || cursor.grant_hash!=grant_hash || cursor.snapshot_seq!=snapshot_seq { return Err(changed()); }
        if object.kind==ObjectKind::File && input.direction==ReferenceDirection::Outgoing {
            let page=ReferenceListPage { object,direction:input.direction,items:vec![],next_cursor:None,complete:true };
            if crate::agent::context::serialized_chars(&page)?>budget { return Err(too_large()); }
            return Ok(page);
        }
        let after = cursor.last_visible_key.as_deref().unwrap_or("");
        let mut remaining_body = MAX_BODY_BYTES;
        let candidates = if input.direction==ReferenceDirection::Incoming {
            self.incoming_candidates(request,&object,after)?
        } else { self.outgoing_candidates(request,&object,after,&mut remaining_body)? };
        let mut items = Vec::new();
        let mut processed = 0;
        let take = candidates.len().min(MAX_CANDIDATES);
        for key in candidates.iter().take(take) {
            let target = super::committed_changes::object_from_key(key,&binding.workspace_id)
                .ok_or_else(|| error(ErrorCode::IoFailed,"Invalid stored reference identity"))?;
            let visible = match self.source_read_object(request,binding,&target) {
                Ok(visible) => visible,
                Err(error) if expected_hidden(&error) => return Err(changed()),
                Err(error) => return Err(error),
            };
            if input.direction==ReferenceDirection::Incoming {
                let edge: bool = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM content_reference_edges WHERE source_object_key=?1 AND target_object_key=?2 AND relation='internal_reference')",params![key,object_key],|r|r.get(0)).map_err(io_error)?;
                if !edge {
                    let mut found = false;
                    let Some(texts) = self.reference_texts(&visible,&mut remaining_body)? else { break; };
                    for text in texts {
                        for (kind,id) in super::parse_internal_reference_tokens(&text) {
                            if Some(kind.as_str())==link_kind(&object) && super::record_references::resolve_reference_object(&self.conn,&kind,id,&object.workspace_id)?.as_ref()==Some(&object) {
                                found = true; break;
                            }
                        }
                        if found { break; }
                    }
                    if !found {
                        cursor.last_visible_key=Some(key.clone());
                        processed+=1;
                        continue;
                    }
                }
            }
            let item = ReferenceItem { object:visible,title:title(self,&target)? };
            let mut tentative = items.clone();
            tentative.push(item.clone());
            let next = Cursor {
                object_key:cursor.object_key.clone(),direction:cursor.direction,
                grant_hash:cursor.grant_hash.clone(),snapshot_seq:cursor.snapshot_seq,
                last_visible_key:Some(key.clone()),
            };
            let tentative_complete=processed+1==candidates.len();
            let envelope = ReferenceListPage {
                object:object.clone(),direction:input.direction,items:tentative,
                next_cursor:if tentative_complete { None } else { Some(encode_cursor(&next)?) },complete:tentative_complete,
            };
            if crate::agent::context::serialized_chars(&envelope)?>budget {
                if items.is_empty() { return Err(too_large()); }
                break;
            }
            items.push(item);
            cursor.last_visible_key = Some(key.clone());
            processed+=1;
            if items.len()==limit { break; }
        }
        let complete = processed==candidates.len();
        let next_cursor = if complete { None } else { Some(encode_cursor(&cursor)?) };
        let page = ReferenceListPage { object,direction:input.direction,items,next_cursor,complete };
        if crate::agent::context::serialized_chars(&page)?>budget { return Err(too_large()); }
        Ok(page)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::connections::ConnectionCreateInput;

    fn fixture() -> (tempfile::TempDir,Database,WorkspaceBinding,RequestContext) {
        let dir=tempfile::tempdir().unwrap();
        let mut db=Database::open(&dir.path().join("refs.sqlite"),dir.path(),None).unwrap();
        db.native_workspace_id=Some("workspace-r".into());
        for (id,archived) in [(1,0),(2,1)] {
            db.conn.execute("INSERT INTO projects(id,name,root_path,is_archived,created_at,updated_at) VALUES(?1,?2,?3,?4,'now','now')",params![id,format!("Project {id}"),format!("workspace:project-{id}"),archived]).unwrap();
        }
        for (id,project,title,body) in [
            (1,1,"目标",""),(2,1,"来源😀","[[note:+001|目标]]"),
            (3,2,"归档来源","[[note:1|目标]]"),(4,1,"附件来源","")
        ] {
            db.conn.execute("INSERT INTO notes(id,project_id,title,content_markdown,content_html,created_at,updated_at) VALUES(?1,?2,?3,?4,'<p></p>','now','now')",params![id,project,title,body]).unwrap();
        }
        db.conn.execute("INSERT INTO workspace_notes(id,note_kind,title,content_markdown,content_html,created_at,updated_at) VALUES(1,'workspace_note','同号 Workspace Record','[[note:1|目标]]','<p></p>','now','now')",[]).unwrap();
        db.conn.execute("INSERT INTO todos(id,scope,project_id,content,priority,created_at,updated_at) VALUES(1,'project',1,'含子行动','not_urgent_not_important','now','now')",[]).unwrap();
        db.conn.execute("INSERT INTO todo_progresses(id,todo_id,content,progress_date,created_at) VALUES(1,1,'[[note:0001|目标]]','2026-01-01','now')",[]).unwrap();
        db.conn.execute("INSERT INTO documents(id,project_id,name,original_path,managed_path,storage_mode,mime_type,created_at,updated_at) VALUES(1,1,'附件.txt','original','managed','managed','text/plain','now','now')",[]).unwrap();
        let binding=WorkspaceBinding{workspace_id:"workspace-r".into(),generation:"open-1".into()};
        let grant=db.agent_connection_create(&binding,&ConnectionCreateInput{ objects: None,
            client_label:"Reference reader".into(),workspace_content:true,project_ids:vec![1],all_projects:false,
            session_read:false,write_operations:vec![],
        },&"a".repeat(32),&"b".repeat(64)).unwrap();
        let request=db.agent_connection_authenticate(&binding,&grant.id,&"b".repeat(64),"reference-read").unwrap();
        (dir,db,binding,request)
    }
    fn object(binding:&WorkspaceBinding,kind:ObjectKind,scope:Scope,id:i64)->ObjectRef {
        ObjectRef{workspace_id:binding.workspace_id.clone(),scope,kind,id:id.to_string()}
    }
    fn list(db:&Database,request:&RequestContext,binding:&WorkspaceBinding,object:ObjectRef,direction:ReferenceDirection)->ReferenceListPage {
        db.agent_reference_list(request,binding,&ReferenceListInput{object,direction,cursor:None,limit:None,budget_chars:None}).unwrap()
    }
    #[test]
    fn old_tokens_todo_children_and_scope_collisions_use_native_identities() {
        let (_dir,db,binding,request)=fixture();
        let target=object(&binding,ObjectKind::Record,Scope::Project{project_id:1},1);
        let incoming=list(&db,&request,&binding,target.clone(),ReferenceDirection::Incoming);
        let keys=incoming.items.iter().map(|item|item.object.key().unwrap()).collect::<Vec<_>>();
        assert!(keys.contains(&object(&binding,ObjectKind::Record,Scope::Project{project_id:1},2).key().unwrap()));
        assert!(keys.contains(&object(&binding,ObjectKind::Record,Scope::Workspace,1).key().unwrap()));
        assert!(keys.contains(&object(&binding,ObjectKind::Todo,Scope::Project{project_id:1},1).key().unwrap()));
        assert!(!keys.contains(&object(&binding,ObjectKind::Record,Scope::Project{project_id:2},3).key().unwrap()));
        let outgoing=list(&db,&request,&binding,object(&binding,ObjectKind::Record,Scope::Project{project_id:1},2),ReferenceDirection::Outgoing);
        assert_eq!(outgoing.items.len(),1);
        assert_eq!(outgoing.items[0].object,target);
        let workspace_target=object(&binding,ObjectKind::Record,Scope::Workspace,1);
        assert!(list(&db,&request,&binding,workspace_target,ReferenceDirection::Incoming).items.is_empty());
    }
    #[test]
    fn canonical_edges_deduplicate_attachments_and_file_has_no_outgoing() {
        let (_dir,db,binding,request)=fixture();
        let source=object(&binding,ObjectKind::Record,Scope::Project{project_id:1},4);
        let file=object(&binding,ObjectKind::File,Scope::Project{project_id:1},1);
        for block in ["a","b"] {
            db.conn.execute("INSERT INTO content_reference_edges(source_object_key,target_object_key,relation,locator_json) VALUES(?1,?2,'internal_reference',?3)",params![source.key().unwrap(),file.key().unwrap(),json!({"blockId":block}).to_string()]).unwrap();
            db.conn.execute("INSERT INTO content_reference_edges(source_object_key,target_object_key,relation,locator_json) VALUES(?1,?1,'internal_reference',?2)",params![source.key().unwrap(),json!({"blockId":block}).to_string()]).unwrap();
        }
        assert_eq!(list(&db,&request,&binding,file.clone(),ReferenceDirection::Incoming).items.len(),1);
        let outgoing=list(&db,&request,&binding,source.clone(),ReferenceDirection::Outgoing);
        assert_eq!(outgoing.items.len(),2);
        assert_eq!(outgoing.items.iter().filter(|item| item.object==source).count(),1);
        assert!(list(&db,&request,&binding,file.clone(),ReferenceDirection::Outgoing).items.is_empty());
        assert_eq!(db.agent_reference_list(&request,&binding,&ReferenceListInput{object:file,direction:ReferenceDirection::Outgoing,cursor:None,limit:None,budget_chars:Some(1)}).unwrap_err().code,ErrorCode::BudgetExceeded);
    }
    #[test]
    fn keyset_pages_fit_serialized_budget_and_detect_changes() {
        let (_dir,db,binding,request)=fixture();
        let target=object(&binding,ObjectKind::Record,Scope::Project{project_id:1},1);
        let mut input=ReferenceListInput{object:target,direction:ReferenceDirection::Incoming,cursor:None,limit:Some(1),budget_chars:Some(1000)};
        let first=db.agent_reference_list(&request,&binding,&input).unwrap();
        assert_eq!(first.items.len(),1);
        assert!(!first.complete);
        assert!(crate::agent::context::serialized_chars(&first).unwrap()<=1000);
        input.cursor=first.next_cursor.clone();
        let second=db.agent_reference_list(&request,&binding,&input).unwrap();
        assert_eq!(second.items.len(),1);
        assert_ne!(first.items[0].object,second.items[0].object);
        db.conn.execute("INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at) VALUES('probe','workspace','test','1','now')",[]).unwrap();
        assert_eq!(db.agent_reference_list(&request,&binding,&input).unwrap_err().code,ErrorCode::SourceChanged);
        input.cursor=None;
        let fresh=db.agent_reference_list(&request,&binding,&input).unwrap();
        let stored:String=db.conn.query_row("SELECT scope_grant_json FROM agent_connection_grants WHERE id=?1",["a".repeat(32)],|r|r.get(0)).unwrap();
        let mut scope:serde_json::Value=serde_json::from_str(&stored).unwrap();
        scope["projectIds"]=json!([1,2]);
        db.conn.execute("UPDATE agent_connection_grants SET scope_grant_json=?1 WHERE id=?2",params![scope.to_string(),"a".repeat(32)]).unwrap();
        let expanded=db.agent_connection_authenticate(&binding,&"a".repeat(32),&"b".repeat(64),"reference-expanded").unwrap();
        input.cursor=fresh.next_cursor;
        assert_eq!(db.agent_reference_list(&expanded,&binding,&input).unwrap_err().code,ErrorCode::SourceChanged);
        input.cursor=None;
        input.budget_chars=Some(1);
        assert_eq!(db.agent_reference_list(&request,&binding,&input).unwrap_err().code,ErrorCode::BudgetExceeded);
    }
    #[test]
    fn policy_withdrawal_archive_and_oversized_old_body_are_not_exposed() {
        let (_dir,db,binding,request)=fixture();
        let target=object(&binding,ObjectKind::Record,Scope::Project{project_id:1},1);
        let hidden=object(&binding,ObjectKind::Record,Scope::Project{project_id:1},2);
        db.conn.execute("INSERT INTO source_access_policies(object_key,excluded,revision) VALUES(?1,1,1)",[hidden.key().unwrap()]).unwrap();
        let keys=list(&db,&request,&binding,target.clone(),ReferenceDirection::Incoming).items.into_iter().map(|item|item.object.key().unwrap()).collect::<Vec<_>>();
        assert!(!keys.contains(&hidden.key().unwrap()));
        db.conn.execute("UPDATE source_access_policies SET excluded=0 WHERE object_key=?1",[hidden.key().unwrap()]).unwrap();
        db.conn.execute("INSERT INTO agent_object_withdrawals(object_key,creation_operation_id,withdrawn_at,revision) VALUES(?1,'create','now',1)",[hidden.key().unwrap()]).unwrap();
        let keys=list(&db,&request,&binding,target.clone(),ReferenceDirection::Incoming).items.into_iter().map(|item|item.object.key().unwrap()).collect::<Vec<_>>();
        assert!(!keys.contains(&hidden.key().unwrap()));
        db.conn.execute("DELETE FROM agent_object_withdrawals WHERE object_key=?1",[hidden.key().unwrap()]).unwrap();
        db.conn.execute("UPDATE notes SET content_markdown=?1 WHERE id=2",[format!("{}[[note:1|目标]]","x".repeat(MAX_BODY_BYTES+1))]).unwrap();
        assert_eq!(db.agent_reference_list(&request,&binding,&ReferenceListInput{object:target.clone(),direction:ReferenceDirection::Incoming,cursor:None,limit:None,budget_chars:None}).unwrap_err().code,ErrorCode::BudgetExceeded);
        let other=ObjectRef{workspace_id:"other".into(),..target};
        assert_eq!(db.agent_reference_list(&request,&binding,&ReferenceListInput{object:other,direction:ReferenceDirection::Incoming,cursor:None,limit:None,budget_chars:None}).unwrap_err().code,ErrorCode::ScopeDenied);
    }
    #[test]
    fn empty_page_of_visible_nonmatches_still_reaches_later_old_link() {
        let (_dir,db,binding,request)=fixture();
        db.conn.execute("UPDATE notes SET content_markdown='' WHERE id=2",[]).unwrap();
        db.conn.execute("UPDATE workspace_notes SET content_markdown='' WHERE id=1",[]).unwrap();
        db.conn.execute("UPDATE todo_progresses SET content='' WHERE id=1",[]).unwrap();
        for id in 100..=200 {
            db.conn.execute("INSERT INTO notes(id,project_id,title,content_markdown,content_html,created_at,updated_at) VALUES(?1,1,'Other','[[note:0002|other]]','<p></p>','now','now')",[id]).unwrap();
        }
        db.conn.execute("INSERT INTO notes(id,project_id,title,content_markdown,content_html,created_at,updated_at) VALUES(999,1,'Last','[[note:+0001|target]]','<p></p>','now','now')",[]).unwrap();
        let mut input=ReferenceListInput{object:object(&binding,ObjectKind::Record,Scope::Project{project_id:1},1),direction:ReferenceDirection::Incoming,cursor:None,limit:None,budget_chars:None};
        let first=db.agent_reference_list(&request,&binding,&input).unwrap();
        assert!(first.items.is_empty());
        assert!(!first.complete);
        input.cursor=first.next_cursor;
        let second=db.agent_reference_list(&request,&binding,&input).unwrap();
        assert_eq!(second.items.len(),1);
        assert_eq!(second.items[0].object.id,"999");
        assert!(second.complete);
    }
    #[test]
    fn cumulative_old_body_budget_pauses_then_resumes_whole_candidate() {
        let (_dir,db,binding,request)=fixture();
        let body=format!("[[note:1|target]]{}","x".repeat(4_500_000));
        for id in [2,4] { db.conn.execute("UPDATE notes SET content_markdown=?1 WHERE id=?2",params![body,id]).unwrap(); }
        let mut input=ReferenceListInput{object:object(&binding,ObjectKind::Record,Scope::Project{project_id:1},1),direction:ReferenceDirection::Incoming,cursor:None,limit:None,budget_chars:None};
        let first=db.agent_reference_list(&request,&binding,&input).unwrap();
        assert_eq!(first.items.iter().map(|item|item.object.id.as_str()).collect::<Vec<_>>(),vec!["2"]);
        assert!(!first.complete);
        input.cursor=first.next_cursor;
        let second=db.agent_reference_list(&request,&binding,&input).unwrap();
        assert!(second.items.iter().any(|item|item.object.id=="4"));
        assert!(!second.items.iter().any(|item|item.object.id=="2"));
        assert!(second.complete);
    }
}
