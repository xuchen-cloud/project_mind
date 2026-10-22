import { CellValueType } from '@univerjs/core';
import { FormulaDataModel } from '@univerjs/engine-formula';
import { SetRangeValuesCommand } from '@univerjs/sheets';
import type { Area, SelectionController } from './types';
/** One bounded target per renderer; only normal workbook commands may write it. */
export function createSelectionController(host: {
    assertAvailable: () => void;
    runtime: () => any;
    state: () => any;
    revision: () => number;
    flush: () => Promise<void>;
}): SelectionController {
    let frozen: {
        selectionId: string;
        sheetId: string;
        range: Area;
        revision: number;
        workbookId: string;
    } | undefined;
    const contains = (a: Area, b: Area) => b.startRow >= a.startRow && b.endRow <= a.endRow && b.startColumn >= a.startColumn && b.endColumn <= a.endColumn;
    const loaded = (sheetId: string, range: Area) => {
        const area = host.state().loadedRanges.get(sheetId);
        if (!area || !contains(area, range)) throw Error('选区内容尚未加载');
    };
    function text(sheet: any, range: Area, updates?: Record<number, Record<number, any>>) {
        const cells = [];
        for (let row = range.startRow; row <= range.endRow; row++) {
            for (let column = range.startColumn; column <= range.endColumn; column++) {
                const cell = updates?.[row]?.[column] ?? sheet.getRange(row, column).getCellData();
                cells.push({row, column, value: cell?.p?.body?.dataStream?.replace(/\r\n$/, '') ?? cell?.v ?? null, ...(cell?.f ? {formula: cell.f} : {})});
            }
        }
        const result = JSON.stringify({sheetId: sheet.getSheetId(), sheetName: sheet.getSheetName(), coordinates: 'absolute-zero-based', range, cells});
        if (result.length > 64_000) throw Error('选区文本超过 64000 字符');
        return result;
    }
    return {
        async captureSelection() {
            host.assertAvailable();
            const workbook = host.runtime().univerAPI.getActiveWorkbook();
            const sheet = workbook?.getActiveSheet();
            const ranges = sheet?.getSelection()?.getActiveRangeList();
            if (!ranges || ranges.length !== 1) throw Error('请选择一个连续单元格选区');
            const raw = ranges[0].getRange();
            const range: Area = {startRow: raw.startRow, endRow: raw.endRow, startColumn: raw.startColumn, endColumn: raw.endColumn};
            if (!Object.values(range).every(Number.isInteger) || range.startRow < 0 || range.startColumn < 0 || range.endRow < range.startRow || range.endColumn < range.startColumn || (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1) > 256) {
                throw Error('选区最多包含 256 个单元格');
            }
            loaded(sheet.getSheetId(), range);
            const content = text(sheet, range);
            frozen = {selectionId: crypto.randomUUID(), sheetId: sheet.getSheetId(), workbookId: workbook.getId(), range, revision: host.revision()};
            return {selectionId: frozen.selectionId, text: content};
        },
        async applySelection(input) {
            host.assertAvailable();
            const target = frozen, workbook = host.runtime().univerAPI.getActiveWorkbook();
            if (!target || input?.selectionId !== target.selectionId || target.revision !== host.revision() || target.workbookId !== workbook?.getId())
                throw Error('Excel 选区已失效或工作簿发生变化');
            const sheet = workbook.getSheetBySheetId(target.sheetId);
            if (!sheet)
                throw Error('选区工作表已失效');
            loaded(target.sheetId, target.range);
            const change = input.change as any;
            if (!change || !Array.isArray(change.cells) || !change.cells.length || change.cells.length > 256)
                throw Error('选区修改需包含 1 至 256 个单元格');
            const value: Record<number, Record<number, unknown>> = {}, seen = new Set<string>();
            const arrayRanges = host.runtime().univer.__getInjector().get(FormulaDataModel).getArrayFormulaRange()?.[target.workbookId]?.[target.sheetId];
            const protectedRanges: Area[] = [...sheet.getMergeData(), ...Object.values(arrayRanges ?? {}).flatMap(row => Object.values(row ?? {}))] as Area[];
            let size = 0;
            for (const cell of change.cells) {
                if (!cell || !Number.isInteger(cell.row) || !Number.isInteger(cell.column) || !contains(target.range, { startRow: cell.row, endRow: cell.row, startColumn: cell.column, endColumn: cell.column }))
                    throw Error('修改超出冻结选区');
                const key = `${cell.row}:${cell.column}`;
                if (seen.has(key))
                    throw Error('选区修改包含重复单元格');
                seen.add(key);
                const existing = sheet.getRange(cell.row, cell.column).getCellData();
                if (existing?.si || protectedRanges.some((merge: Area) => contains(merge, { startRow: cell.row, endRow: cell.row, startColumn: cell.column, endColumn: cell.column })))
                    throw Error('选区暂不支持合并、共享或数组公式单元格');
                const data: any = { v: null, f: null, si: null, p: null, t: CellValueType.STRING };
                if (cell.kind === 'string' && typeof cell.value === 'string') {
                    data.v = cell.value;
                    size += cell.value.length;
                }
                else if (cell.kind === 'number' && typeof cell.value === 'number' && Number.isFinite(cell.value)) {
                    data.v = cell.value;
                    data.t = CellValueType.NUMBER;
                }
                else if (cell.kind === 'formula' && typeof cell.formula === 'string' && cell.formula.startsWith('=') && cell.formula.length > 1) {
                    data.f = cell.formula;
                    size += cell.formula.length;
                }
                else if (cell.kind !== 'blank')
                    throw Error('无效的选区单元格值');
                if (size > 64000)
                    throw Error('选区修改超过 64000 字符');
                (value[cell.row] ??= {})[cell.column] = data;
            }
            // Validate the resulting context budget before the single undoable write.
            text(sheet, target.range, value);
            frozen = undefined;
            const ok = await host.runtime().univerAPI.executeCommand(SetRangeValuesCommand.id, { unitId: target.workbookId, subUnitId: target.sheetId, range: target.range, value });
            if (!ok)
                throw Error('选区修改被工作簿拒绝');
            await host.flush();
            return { text: text(sheet, target.range) };
        }
    };
}
