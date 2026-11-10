use std::fs::File;
use std::io::Write;
use std::sync::atomic::AtomicBool;
use xlsx_sidecar::{CellRange, THREADS, WorkbookSessions};
use zip::write::SimpleFileOptions;

#[test]
fn first_range_has_tail_metadata_before_cell_index_finishes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("progressive.xlsx");
    let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, text) in [
        (
            "xl/workbook.xml",
            r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
        ),
        (
            "xl/_rels/workbook.xml.rels",
            r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
        ),
    ] {
        zip.start_file(name, options).unwrap();
        zip.write_all(text.as_bytes()).unwrap();
    }
    zip.start_file("xl/worksheets/sheet1.xml", options).unwrap();
    zip.write_all(br#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B100000"/><sheetData>"#).unwrap();
    for row in 1..=100000 {
        write!(zip, "<row r=\"{row}\"><c r=\"A{row}\"><v>{row}</v></c><c r=\"B{row}\"><f>A{row}*2</f><v>{}</v></c></row>", row*2).unwrap();
    }
    zip.write_all(br#"</sheetData><sheetProtection sheet="1" password="CBEB"/><mergeCells><mergeCell ref="A1:B1"/></mergeCells><dataValidations count="1"><dataValidation type="whole" sqref="A2:A20"><formula1>1</formula1></dataValidation></dataValidations></worksheet>"#).unwrap();
    zip.finish().unwrap();
    let mut sessions = WorkbookSessions::new();
    let metadata = sessions.open_view(&path, &AtomicBool::new(false)).unwrap();
    assert_eq!(
        metadata.sheets[0].stored_cell_count, None,
        "trusted GUI dimensions must not count every cell before first range"
    );
    let range = CellRange {
        start_row: 0,
        end_row: 99,
        start_column: 0,
        end_column: 1,
    };
    let first = sessions
        .read_range(&metadata.session_id, "sheet-1", &range)
        .unwrap();
    assert!(first.metadata_ready);
    assert!(first.sheet_protection.unwrap().protected);
    assert_eq!(first.merges.len(), 1);
    assert_eq!(first.data_validations.len(), 1);
    assert!(first.indexed_through_row.unwrap() >= 99);
    assert!(first.cells.iter().all(|cell| cell.row < 100));
    if THREADS {
        assert!(
            !first.indexing_complete,
            "first viewport must be returned while the actual tail index is still running"
        );
    }
    sessions.close(&metadata.session_id).unwrap();
}
