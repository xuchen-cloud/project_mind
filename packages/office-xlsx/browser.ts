import { BooleanNumber, BorderStyleTypes, CellValueType, CommandType, HorizontalAlign, LocaleType,
  LogLevel, LifecycleStages, Univer, VerticalAlign, WrapStrategy, type ICellData, type IStyleData,
  type IWorkbookData, type IWorksheetData, type IUniverConfig } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { UniverSheetsCorePreset, SetRangeValuesMutation, type ISetRangeValuesMutationParams } from '@univerjs/preset-sheets-core'
import ZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import '@univerjs/preset-sheets-core/lib/index.css'
import { defaultTheme } from '@univerjs/themes'
import './browser.css'
import type { Cell, Edit, EditorProps, Model, MountedEditor, Style } from './types'
export type { Model, Edit, EditorProps } from './types'

const yes = (value: boolean) => value ? BooleanNumber.TRUE : BooleanNumber.FALSE
function cellData(cell: Cell): ICellData {
  return { v: cell.value, f: cell.formula ?? null,
    t: typeof cell.value === 'number' ? CellValueType.NUMBER : typeof cell.value === 'boolean' ? CellValueType.BOOLEAN : CellValueType.STRING,
    s: String(cell.styleIndex ?? 0) }
}
function cellEdit(sheetId: string, row: number, column: number, cell: ICellData | null | undefined): Edit {
  const coord = { sheetId, row, column }
  if (cell?.f) return { ...coord, kind: 'formula', formula: cell.f }
  const value = cell?.p?.body?.dataStream?.replace(/\r\n$/, '') ?? cell?.v
  if (value === null || value === undefined) return { ...coord, kind: 'blank' }
  if (typeof value === 'number') return { ...coord, kind: 'number', value }
  if (typeof value === 'string') return { ...coord, kind: 'string', value }
  throw new Error('当前仅支持文本、数值、空白和公式编辑')
}
function editCell(edit: Edit, style: string | IStyleData | null | undefined): ICellData {
  return { s: style, p: null, f: edit.kind === 'formula' ? edit.formula : null,
    v: edit.kind === 'blank' || edit.kind === 'formula' ? null : edit.value,
    t: edit.kind === 'number' ? CellValueType.NUMBER : CellValueType.STRING }
}
const key = (e: Pick<Edit, 'sheetId' | 'row' | 'column'>) => `${e.sheetId}:${e.row}:${e.column}`
function same(a: Edit, b: Edit) {
  return a.kind === b.kind && (a.kind === 'blank' || (a.kind === 'formula' && b.kind === 'formula' ? a.formula === b.formula :
    'value' in a && 'value' in b && a.value === b.value))
}
const borders: Record<string, BorderStyleTypes> = {
  thin: BorderStyleTypes.THIN, medium: BorderStyleTypes.MEDIUM, thick: BorderStyleTypes.THICK,
  double: BorderStyleTypes.DOUBLE, dashed: BorderStyleTypes.DASHED, dotted: BorderStyleTypes.DOTTED,
  hair: BorderStyleTypes.HAIR, dashDot: BorderStyleTypes.DASH_DOT, dashDotDot: BorderStyleTypes.DASH_DOT_DOT,
}
function styleData(style: Style): IStyleData {
  const bd: NonNullable<IStyleData['bd']> = {}
  for (const [property, edge] of [['borderTop', 't'], ['borderBottom', 'b'], ['borderLeft', 'l'], ['borderRight', 'r']] as const) {
    const border = style[property]
    if (border) bd[edge] = { s: borders[border.style] ?? BorderStyleTypes.THIN, cl: { rgb: border.color } }
  }
  return { ff: style.fontFamily, fs: style.fontSize, bl: yes(style.bold), it: yes(style.italic),
    ul: { s: yes(style.underline) }, st: { s: yes(style.strikethrough) },
    cl: { rgb: style.fontColor }, bg: { rgb: style.fillColor }, bd,
    n: style.numberFormat ? { pattern: style.numberFormat } : undefined,
    ht: ({ left: HorizontalAlign.LEFT, center: HorizontalAlign.CENTER, right: HorizontalAlign.RIGHT } as Record<string, HorizontalAlign>)[style.horizontalAlignment ?? ''],
    vt: ({ top: VerticalAlign.TOP, center: VerticalAlign.MIDDLE, bottom: VerticalAlign.BOTTOM } as Record<string, VerticalAlign>)[style.verticalAlignment ?? ''],
    tb: style.wrapText ? WrapStrategy.WRAP : WrapStrategy.OVERFLOW }
}
function snapshot(model: Model, edits: Edit[]): IWorkbookData {
  const sheets: Record<string, Partial<IWorksheetData>> = {}
  for (const sheet of model.sheets) {
    const range = model.ranges[sheet.id]
    if (!range || range.area.startRow !== 0 || range.area.startColumn !== 0) throw new Error('编辑器需要从 A1 开始的连续已加载范围')
    const cellMatrix: IWorksheetData['cellData'] = {}
    for (const cell of range.cells) (cellMatrix[cell.row] ??= {})[cell.column] = cellData(cell)
    for (const edit of edits.filter((e) => e.sheetId === sheet.id)) {
      if (edit.row > range.area.endRow || edit.column > range.area.endColumn) throw new Error('草稿超出已加载范围')
      const existing = cellMatrix[edit.row]?.[edit.column]
      ;(cellMatrix[edit.row] ??= {})[edit.column] = editCell(edit, existing?.s ?? '0')
    }
    const columnData: IWorksheetData['columnData'] = {}
    for (const info of sheet.columnWidths) for (let c = info.startColumn; c <= Math.min(info.endColumn, range.area.endColumn); c++) {
      columnData[c] = { w: info.width === undefined ? undefined : info.width * 7 + 5, hd: yes(info.hidden), s: info.styleIndex === undefined ? undefined : String(info.styleIndex) }
    }
    const rowData: IWorksheetData['rowData'] = {}
    for (const info of range.rows) rowData[info.row] = { h: info.height === undefined ? undefined : info.height * 4 / 3, hd: yes(info.hidden),
      s: info.styleIndex === undefined ? undefined : String(info.styleIndex) }
    sheets[sheet.id] = { id: sheet.id, name: sheet.name, hidden: yes(sheet.hidden), tabColor: sheet.tabColor ?? '',
      rowCount: range.area.endRow + 1, columnCount: range.area.endColumn + 1,
      cellData: cellMatrix, columnData, rowData, defaultStyle: '0',
      defaultRowHeight: (sheet.defaultRowHeight ?? 15) * 4 / 3,
      defaultColumnWidth: (sheet.defaultColumnWidth ?? 8.43) * 7 + 5,
      mergeData: range.merges.filter((m) => m.endRow <= range.area.endRow && m.endColumn <= range.area.endColumn),
      showGridlines: yes(sheet.showGridLines),
      freeze: { xSplit: sheet.freeze?.frozenColumns ?? 0, ySplit: sheet.freeze?.frozenRows ?? 0,
        startRow: sheet.freeze?.frozenRows ?? -1, startColumn: sheet.freeze?.frozenColumns ?? -1 } }
  }
  return { id: crypto.randomUUID(), name: model.name, appVersion: '0.25.1', locale: LocaleType.ZH_CN,
    styles: Object.fromEntries(model.styles.map((style, index) => [String(index), styleData(style)])),
    defaultStyle: '0', sheets, sheetOrder: model.sheets.map((s) => s.id) }
}

/** DOM boundary keeps Univer/React dependencies in one isolated browser bundle.
 * No I/O, save, upload or persistence. A new model reference is a new baseline.
 * Native theme can be supplied by the host after its design contract is settled.
 */
export function mount(container: HTMLElement, initial: EditorProps, options: { theme?: IUniverConfig['theme'] } = {}): MountedEditor {
  let props = initial
  let univer: Univer
  let api: FUniver
  let workbook: ReturnType<FUniver['createWorkbook']>
  let journal = new Map(initial.edits.map((e) => [key(e), e]))
  let applying = false
  let ready: Promise<void>
  let rendered = false
  let pending = false
  function setPending(value: boolean) {
    if (pending === value) return
    pending = value
    props.onPendingChange?.(value)
  }
  const status = document.createElement('div')
  status.setAttribute('role', 'alert')
  const notice = document.createElement('div')
  notice.className = 'office-xlsx-notice'
  notice.setAttribute('role', 'note')
  notice.setAttribute('aria-label', '预览范围')
  const canvasHost = document.createElement('div')
  container.classList.add('office-xlsx-editor')
  canvasHost.className = 'office-xlsx-canvas'
  status.className = 'office-xlsx-status'
  const toolbar = document.createElement('div')
  toolbar.className = 'office-xlsx-toolbar'
  toolbar.setAttribute('role', 'toolbar')
  toolbar.setAttribute('aria-label', '内容编辑')
  const buttons = (['undo', 'redo'] as const).map((action) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.title = action === 'undo' ? '撤销' : '重做'
    button.setAttribute('aria-label', button.title)
    const path = action === 'undo' ? 'M9 5 5 9l4 4M5 9h7a5 5 0 0 1 0 10' : 'm15 5 4 4-4 4m4-4h-7a5 5 0 0 0 0 10'
    button.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="${path}"/></svg>`
    button.addEventListener('click', () => { if (!props.readOnly) void api[action]() })
    toolbar.append(button)
    return button
  })
  container.replaceChildren(toolbar, status, canvasHost, notice)
  function updateNotice() {
    const activeId = workbook.getActiveSheet()?.getSheetId() ?? props.model.activeSheetId
    const sheet = props.model.sheets.find((sheet) => sheet.id === activeId)
    const range = props.model.ranges[activeId]
    const messages: string[] = []
    if (sheet && range && (sheet.rowCount > range.area.endRow + 1 || sheet.columnCount > range.area.endColumn + 1)) {
      let column = range.area.endColumn + 1, label = ''
      while (column > 0) { column--; label = String.fromCharCode(65 + column % 26) + label; column = Math.floor(column / 26) }
      messages.push(`当前工作表显示 A1–${label}${range.area.endRow + 1}；其余区域保留在原文件中。`)
    }
    const kinds = new Set(props.model.visuals.filter((v): v is {kind: string} => !!v && typeof v === 'object' && 'kind' in v && typeof v.kind === 'string').map((v) => v.kind))
    const objects = [kinds.has('chart') && '图表', kinds.has('image') && '图片'].filter(Boolean).join('、')
    if (objects) messages.push(`${objects}暂未预览，原件内容仍保留。`)
    notice.textContent = messages.join(' ')
  }
  function build() {
    rendered = false
    canvasHost.style.pointerEvents = 'none'
    container.dataset.officeReady = 'false'
    univer = new Univer({ locale: LocaleType.ZH_CN, locales: { [LocaleType.ZH_CN]: ZhCN }, logLevel: LogLevel.ERROR,
      theme: options.theme ?? hostTheme(container) })
    const preset = UniverSheetsCorePreset({ container: canvasHost, header: true, toolbar: false, contextMenu: false,
      formulaBar: true, footer: { sheetBar: true, statisticBar: false, menus: false, addSheetButtonConfig: { show: false } },
      formula: { initialFormulaComputing: modelComplete(props.model) ? 0 : 2 } })
    for (const entry of preset.plugins) {
      const [plugin, config] = Array.isArray(entry) ? entry : [entry, undefined]
      univer.registerPlugin(plugin, config)
    }
    api = FUniver.newAPI(univer)
    workbook = api.createWorkbook(snapshot(props.model, props.edits))
    workbook.setEditable(false)
    buttons.forEach((button) => { button.disabled = true })
    ready = new Promise((resolve) => {
      api.addEvent(api.Event.LifeCycleChanged, ({ stage }) => {
        if (stage !== LifecycleStages.Rendered) return
        queueMicrotask(() => {
          rendered = true
          canvasHost.style.pointerEvents = ''
          workbook.setEditable(!props.readOnly)
          buttons.forEach((button) => { button.disabled = props.readOnly })
          container.dataset.officeReady = 'true'
          resolve()
        })
      })
    })
    const active = props.model.sheets.find((s) => s.id === props.model.activeSheetId && !s.hidden) ?? props.model.sheets.find((s) => !s.hidden)
    if (active) workbook.setActiveSheet(workbook.getSheetBySheetId(active.id)!)
    updateNotice()
    api.addEvent(api.Event.ActiveSheetChanged, updateNotice)
    api.addEvent(api.Event.BeforeCommandExecute, (event) => {
      if (applying || event.type !== CommandType.MUTATION || !event.id.startsWith('sheet.mutation.')) return
      // Cell content, calculated values and native auto-height are the only supported mutations.
      if (event.id !== SetRangeValuesMutation.id && event.id !== 'sheet.mutation.set-formula-calculation-result' && event.id !== 'sheet.mutation.set-row-auto-height') {
        event.cancel = true
        status.textContent = '当前仅支持单元格内容编辑'
        return
      }
      if (event.id !== SetRangeValuesMutation.id) return
      const params = event.params as ISetRangeValuesMutationParams
      const range = props.model.ranges[params.subUnitId]
      if (props.readOnly || range?.sheetProtection) { event.cancel = true; return }
      for (const [r, cols] of Object.entries(params.cellValue ?? {})) for (const [c, value] of Object.entries(cols)) {
        if (!range || +r > range.area.endRow || +c > range.area.endColumn) { event.cancel = true; status.textContent = '请先加载此范围'; return }
        if (range.cells.some((cell) => cell.row === +r && cell.column === +c && cell.arrayRef)) { event.cancel = true; status.textContent = '当前不支持数组公式编辑'; return }
        const data = value as ICellData | null
        if (data && 's' in data && !('v' in data) && !('f' in data) && !('p' in data)) { event.cancel = true; status.textContent = '当前仅支持单元格内容编辑'; return }
        if (data?.t === CellValueType.BOOLEAN || typeof data?.v === 'boolean') { event.cancel = true; status.textContent = '当前仅支持文本、数值、空白和公式编辑'; return }
      }
    })
    api.onCommandExecuted((command) => {
      if (applying || props.readOnly || command.id !== SetRangeValuesMutation.id) return
      const params = command.params as ISetRangeValuesMutationParams
      if (!params.cellValue) return
      const sheet = workbook.getSheetBySheetId(params.subUnitId)
      if (!sheet) return
      let changed = false
      for (const [r, cols] of Object.entries(params.cellValue)) for (const c of Object.keys(cols)) {
        const cell = sheet.getRange(+r, +c).getCellData()
        const next = cellEdit(params.subUnitId, +r, +c, cell)
        const baseCell = props.model.ranges[params.subUnitId].cells.find((v) => v.row === +r && v.column === +c)
        // Boolean source cells are untouched until replaced by a supported type.
        const base = typeof baseCell?.value === 'boolean' && !baseCell.formula ? null : cellEdit(params.subUnitId, +r, +c, baseCell ? cellData(baseCell) : null)
        const previous = journal.get(key(next))
        if (base && same(base, next)) { changed ||= journal.delete(key(next)) }
        else if (!previous || !same(previous, next)) { journal.set(key(next), next); changed = true }
      }
      if (changed) { status.textContent = ''; props.onChange([...journal.values()]) }
    })
    api.addEvent(api.Event.SheetEditChanging, ({ worksheet, row, column, value }) => {
      if (applying || props.readOnly) return
      const cell = worksheet.getRange(row, column).getCellData()
      const current = cell?.f ?? cell?.p?.body?.dataStream?.replace(/\r\n$/, '') ?? String(cell?.v ?? '')
      const input = value.getData().body?.dataStream?.replace(/\r\n$/, '') ?? ''
      // SDK uses document mutations to populate the cell editor too. Selection
      // and opening an unchanged editor do not create pending content.
      if (input !== current) { status.textContent = ''; setPending(true) }
    })
    api.addEvent(api.Event.BeforeSheetEditEnd, (event) => {
      if (!event.isConfirm || !pending) return
      const text = event.value.getData().body?.dataStream?.replace(/\r\n$/, '').trim() ?? ''
      // The SDK interprets TRUE/FALSE as boolean cells. They are outside the
      // typed save contract; keep the live editor and pending input intact.
      if (/^(true|false)$/i.test(text)) {
        event.cancel = true
        status.textContent = '当前仅支持文本、数值、空白和公式编辑；布尔文本请以单引号开头'
      }
    })
    api.addEvent(api.Event.SheetEditEnded, ({ isConfirm }) => {
      // SetRangeValuesMutation settles the synchronous cell journal before
      // this event; Escape is an explicit cancellation.
      if (!isConfirm) status.textContent = ''
      setPending(false)
    })
  }
  build()
  return {
    get ready() { return ready },
    async commitEditing() {
      await ready
      try {
        if (!props.readOnly) {
          const committed = await workbook.endEditingAsync(true)
          // SDK returns true even when a BeforeSheetEditEnd hook canceled the
          // operation. Its live editor state is the authoritative outcome.
          if (!committed || workbook.isCellEditing()) throw new Error(status.textContent || '单元格编辑未能提交')
        }
      } catch (cause) {
        if (status.textContent) throw new Error(status.textContent, { cause })
        throw cause
      }
    },
    update(next) {
      const previous = props
      props = next
      if (previous.model !== next.model) {
        univer.dispose(); setPending(false); journal = new Map(next.edits.map((e) => [key(e), e])); status.textContent = ''; build(); return
      }
      workbook.setEditable(rendered && !next.readOnly)
      buttons.forEach((button) => { button.disabled = !rendered || next.readOnly })
      if (next.readOnly && !previous.readOnly) void workbook.endEditingAsync(false)
      const incoming = new Map(next.edits.map((e) => [key(e), e]))
      applying = true
      try {
        for (const cellKey of new Set([...journal.keys(), ...incoming.keys()])) {
          const change = incoming.get(cellKey)
          const old = journal.get(cellKey)
          if (change && old && same(change, old)) continue
          const coord = change ?? old!
          const base = next.model.ranges[coord.sheetId].cells.find((c) => c.row === coord.row && c.column === coord.column)
          const target = workbook.getSheetBySheetId(coord.sheetId)!.getRange(coord.row, coord.column)
          target.setValue(change ? editCell(change, target.getCellData()?.s ?? undefined) : base ? cellData(base) : { v: null, f: null, p: null })
        }
        journal = incoming
      } finally { applying = false }
    },
    dispose() { univer.dispose(); setPending(false); container.replaceChildren() },
  }
}
/** SDK shell palette only. File styles still come exclusively from the model. */
function hostTheme(element: HTMLElement): IUniverConfig['theme'] {
  const css = getComputedStyle(element)
  const token = (name: string) => {
    const value = css.getPropertyValue(name).trim()
    if (!value) throw new Error(`Missing Office host token: ${name}`)
    return value
  }
  const bg = token('--color-bg'), subtle = token('--color-bg-subtle'), canvas = token('--color-canvas')
  const border = token('--color-border'), primary = token('--color-text-primary'), secondary = token('--color-text-secondary')
  const tertiary = token('--color-text-tertiary'), accent = token('--color-accent')
  return { ...defaultTheme, white: bg, black: primary,
    primary: { 50: subtle, 100: canvas, 200: border, 300: accent, 400: accent, 500: accent, 600: accent, 700: accent, 800: primary, 900: primary },
    gray: { 50: subtle, 100: canvas, 200: border, 300: tertiary, 400: secondary, 500: secondary, 600: secondary, 700: primary, 800: primary, 900: primary } }
}
function modelComplete(model: Model) {
  return model.sheets.every((s) => model.ranges[s.id].area.endRow + 1 >= s.rowCount && model.ranges[s.id].area.endColumn + 1 >= s.columnCount)
}
export const mountEditor = mount
