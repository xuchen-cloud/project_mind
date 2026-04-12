import { ResizableNodeView, type NodeViewRendererProps } from "@tiptap/core";
import { Table as TiptapTable } from "@tiptap/extension-table";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView, ViewMutationRecord } from "@tiptap/pm/view";

export const ManagedTable = TiptapTable.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      style: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizeTableStyle(element.getAttribute("style")),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes.style === "string" && attributes.style.trim().length > 0
            ? { style: attributes.style }
            : {},
      },
    };
  },
  addNodeView() {
    return (props: NodeViewRendererProps) => {
      const { node, editor, HTMLAttributes, view } = props;
      const table = document.createElement("table");
      const colgroup = table.appendChild(document.createElement("colgroup"));
      const tbody = table.appendChild(document.createElement("tbody"));

      table.className = [this.options.HTMLAttributes?.class, HTMLAttributes.class]
        .filter(Boolean)
        .join(" ");

      let currentNode = node;

      const syncTable = (nextNode = currentNode) => {
        currentNode = nextNode;
        updateManagedColumns(nextNode, colgroup, table, this.options.cellMinWidth);
      };

      syncTable(node);

      const resizable = new ResizableNodeView({
        element: table,
        contentElement: tbody,
        node,
        editor,
        getPos: () => findNodePos(view, table, "table"),
        onResize: (width) => {
          const nextWidth = Math.max(getMinimumTableWidth(currentNode, this.options.cellMinWidth), width);

          table.style.width = `${nextWidth}px`;
          table.style.minWidth = `${getMinimumTableWidth(currentNode, this.options.cellMinWidth)}px`;
        },
        onCommit: (width) => {
          const pos = findNodePos(view, table, "table");

          if (typeof pos !== "number") {
            return;
          }

          const nextWidth = Math.max(getMinimumTableWidth(currentNode, this.options.cellMinWidth), width);
          const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
            ...currentNode.attrs,
            style: `width: ${Math.round(nextWidth)}px;`,
          });

          editor.view.dispatch(tr);
        },
        onUpdate: (updatedNode) => {
          syncTable(updatedNode);
          return true;
        },
        options: {
          directions: ["bottom-right"],
          min: {
            width: Math.max(this.options.cellMinWidth * 2, MIN_TABLE_WIDTH),
            height: MIN_TABLE_HEIGHT,
          },
          className: {
            container: "tableWrapper rich-editor__table-node",
            wrapper: "rich-editor__table-wrapper",
            handle: "rich-editor__resize-handle rich-editor__table-resize-handle",
            resizing: "is-resizing",
          },
          createCustomHandle: () => {
            const handle = document.createElement("button");

            handle.type = "button";
            handle.className = "rich-editor__resize-handle rich-editor__table-resize-handle";
            handle.setAttribute("aria-label", "调整表格大小");
            handle.setAttribute("title", "调整表格大小");
            handle.dataset.resizeHandle = "bottom-right";

            return handle;
          },
        },
      });

      return {
        dom: resizable.dom,
        contentDOM: resizable.contentDOM,
        update: resizable.update.bind(resizable),
        destroy: resizable.destroy.bind(resizable),
        stopEvent: (event: Event) =>
          event.target instanceof HTMLElement &&
          event.target.closest(".rich-editor__table-resize-handle") !== null,
        ignoreMutation: (mutation: ViewMutationRecord) => {
          const target = mutation.target as Node;
          const isInsideWrapper = resizable.dom.contains(target);
          const isInsideContent = tbody.contains(target);

          if (isInsideWrapper && !isInsideContent) {
            return true;
          }

          return false;
        },
      };
    };
  },
});

const MIN_TABLE_WIDTH = 220;
const MIN_TABLE_HEIGHT = 48;

function updateManagedColumns(
  node: ProseMirrorNode,
  colgroup: HTMLTableColElement,
  table: HTMLTableElement,
  cellMinWidth: number,
  overrideCol?: number,
  overrideValue?: number,
) {
  let totalWidth = 0;
  let fixedWidth = true;
  let nextDOM = colgroup.firstChild;
  const row = node.firstChild;

  if (row !== null) {
    for (let cellIndex = 0, columnIndex = 0; cellIndex < row.childCount; cellIndex += 1) {
      const { colspan, colwidth } = row.child(cellIndex).attrs;

      for (let spanIndex = 0; spanIndex < colspan; spanIndex += 1, columnIndex += 1) {
        const width =
          overrideCol === columnIndex
            ? overrideValue
            : ((colwidth && colwidth[spanIndex]) as number | undefined);
        const cssWidth = width ? `${width}px` : "";

        totalWidth += width || cellMinWidth;

        if (!width) {
          fixedWidth = false;
        }

        if (!nextDOM) {
          const colElement = document.createElement("col");
          const [propertyKey, propertyValue] = getColStyleDeclaration(cellMinWidth, width);

          colElement.style.setProperty(propertyKey, propertyValue);
          colgroup.appendChild(colElement);
        } else {
          if ((nextDOM as HTMLTableColElement).style.width !== cssWidth) {
            const [propertyKey, propertyValue] = getColStyleDeclaration(cellMinWidth, width);

            (nextDOM as HTMLTableColElement).style.removeProperty("width");
            (nextDOM as HTMLTableColElement).style.removeProperty("min-width");
            (nextDOM as HTMLTableColElement).style.setProperty(propertyKey, propertyValue);
          }

          nextDOM = nextDOM.nextSibling;
        }
      }
    }
  }

  while (nextDOM) {
    const after = nextDOM.nextSibling;

    nextDOM.parentNode?.removeChild(nextDOM);
    nextDOM = after;
  }

  const userWidth = extractWidthFromStyle(
    typeof node.attrs.style === "string" ? node.attrs.style : null,
  );

  if (userWidth) {
    table.style.width = `${Math.max(userWidth, totalWidth)}px`;
    table.style.minWidth = `${totalWidth}px`;
    return;
  }

  if (fixedWidth) {
    table.style.width = `${totalWidth}px`;
    table.style.minWidth = "";
    return;
  }

  table.style.width = "";
  table.style.minWidth = `${totalWidth}px`;
}

function getColStyleDeclaration(minWidth: number, width?: number): [string, string] {
  if (width) {
    return ["width", `${Math.max(width, minWidth)}px`];
  }

  return ["min-width", `${minWidth}px`];
}

function normalizeTableStyle(style: string | null | undefined) {
  const width = extractWidthFromStyle(style);

  return width ? `width: ${width}px;` : null;
}

function extractWidthFromStyle(style: string | null | undefined) {
  if (!style) {
    return null;
  }

  const match = style.match(/(?:^|;)\s*width\s*:\s*([0-9]+(?:\.[0-9]+)?)px\s*(?:;|$)/i);

  if (!match) {
    return null;
  }

  return Math.round(Number(match[1]));
}

function getMinimumTableWidth(node: ProseMirrorNode, cellMinWidth: number) {
  const firstRow = node.firstChild;
  let columns = 0;

  firstRow?.forEach((cell) => {
    columns += cell.attrs.colspan ?? 1;
  });

  return Math.max(columns * cellMinWidth, MIN_TABLE_WIDTH);
}

function findNodePos(editorView: EditorView, element: HTMLElement, nodeTypeName: string) {
  let pos: number;

  try {
    pos = editorView.posAtDOM(element, 0);
  } catch {
    return undefined;
  }

  const $pos = editorView.state.doc.resolve(pos);

  for (let depth = $pos.depth; depth >= 0; depth -= 1) {
    if ($pos.node(depth).type.name === nodeTypeName) {
      return depth === 0 ? 0 : $pos.before(depth);
    }
  }

  return undefined;
}
