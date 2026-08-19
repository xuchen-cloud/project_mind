import type { ExportBlock, ExportInline, RecordExportDocument } from "./recordExportModel";

export function generateMarkdown(
  document: RecordExportDocument,
  options: { imageReferences?: ReadonlyMap<string, string> } = {},
) {
  const frontMatter = ["---"];
  if (document.title) frontMatter.push(`title: ${yamlString(document.title)}`);
  if (document.projectName) frontMatter.push(`project: ${yamlString(document.projectName)}`);
  if (document.tags.length > 0) {
    frontMatter.push("tags:", ...document.tags.map((tag) => `  - ${yamlString(tag)}`));
  }
  if (document.updatedAt) frontMatter.push(`updated: ${yamlString(document.updatedAt)}`);
  frontMatter.push("---");

  const blocks: string[] = [];
  if (document.title) blocks.push(`# ${escapeMarkdownText(document.title)}`);
  blocks.push(...document.blocks.map((block) => renderBlock(block, options.imageReferences)).filter(Boolean));
  return `${frontMatter.join("\n")}\n\n${blocks.join("\n\n").replace(/\n{3,}/gu, "\n\n").trimEnd()}\n`;
}

function renderBlock(block: ExportBlock, imageReferences?: ReadonlyMap<string, string>): string {
  switch (block.type) {
    case "paragraph": return renderInlines(block.content);
    case "heading": return `${"#".repeat(block.level)} ${renderInlines(block.content)}`;
    case "bulletList":
    case "orderedList":
    case "taskList":
      return block.items.map((item, index) => {
        const marker = block.type === "orderedList" ? `${index + 1}.` : block.type === "taskList" ? `- [${item.checked ? "x" : " "}]` : "-";
        return `${marker} ${item.blocks.map((nested) => renderBlock(nested, imageReferences)).join("\n\n").replace(/\n/gu, "\n  ")}`;
      }).join("\n");
    case "blockquote":
      return block.blocks.map((nested) => renderBlock(nested, imageReferences)).join("\n\n").split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
    case "table": return renderTable(block, imageReferences);
    case "codeBlock": return `\`\`\`${block.language ?? ""}\n${block.code.replace(/\n+$/u, "")}\n\`\`\``;
    case "image": {
      const label = block.alt ?? block.title;
      const reference = imageReferences?.get(block.id);
      if (reference) return `![${escapeMarkdownAlt(label ?? "图片")}](${reference})`;
      return label ? `[图片未导出：${label}]` : "[图片未导出]";
    }
    case "attachment": return `[附件：${block.title}]`;
  }
}

function renderTable(block: Extract<ExportBlock, { type: "table" }>, imageReferences?: ReadonlyMap<string, string>) {
  if (block.rows.length === 0) return "";
  const width = Math.max(...block.rows.map((row) => row.cells.length));
  const rows = block.rows.map((row) => Array.from({ length: width }, (_, index) => tableCellText(row.cells[index]?.blocks ?? [], imageReferences)));
  const header = rows[0] ?? [];
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.slice(1).map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function tableCellText(blocks: ExportBlock[], imageReferences?: ReadonlyMap<string, string>) {
  return blocks.map((block) => renderBlock(block, imageReferences)).join(" ").replaceAll("|", "\\|").replace(/\s+/gu, " ").trim();
}

function renderInlines(inlines: ExportInline[]) {
  return inlines.map((inline) => {
    let value = inline.code ? `\`${inline.text.replaceAll("`", "\\`")}\`` : escapeMarkdownText(inline.text);
    if (inline.bold) value = `**${value}**`;
    if (inline.italic) value = `*${value}*`;
    if (inline.strike) value = `~~${value}~~`;
    if (inline.href) value = `[${value}](${inline.href})`;
    return value;
  }).join("");
}

function escapeMarkdownText(value: string) {
  return value.replace(/([\\[\]*_~`])/gu, "\\$1");
}

function yamlString(value: string) {
  return JSON.stringify(value);
}

function escapeMarkdownAlt(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
}
