import { fromMarkdown } from 'mdast-util-from-markdown';
export function localResourcePath(reference) {
  if (!reference || /^(?:[a-z][a-z\d+.-]*:|[/\\#?])/iu.test(reference)) return undefined;
  return decodeURIComponent(reference.split(/[?#]/u, 1)[0]);
}
export function markdownImageReferences(text) {
  const tree = fromMarkdown(text);
  const definitions = new Map(); const images = [];
  const walk = (node, visit) => { visit(node); for (const child of node.children ?? []) walk(child, visit); };
  walk(tree, node => { if (node.type === 'definition') definitions.set(node.identifier.toUpperCase(), node.url); });
  walk(tree, node => {
    const reference = node.type === 'image' ? node.url : node.type === 'imageReference' ? definitions.get(node.identifier.toUpperCase()) : undefined;
    if (reference) images.push(reference);
  });
  return [...new Set(images)];
}
/** Rewrite only resolved destinations; unavailable resource nodes retain their authored alt text. */
export function withResolvedMarkdownImages(text, resources) {
  const tree = fromMarkdown(text); const replacements = []; const definitions = new Map();
  const walk = (node, visit) => { visit(node); for (const child of node.children ?? []) walk(child, visit); };
  walk(tree, node => { if (node.type === 'definition') definitions.set(node.identifier.toUpperCase(), node.url); });
  walk(tree, node => {
    if (node.type !== 'image' && node.type !== 'imageReference') return;
    const reference = node.type === 'image' ? node.url : definitions.get(node.identifier.toUpperCase());
    const escaped = (node.alt ?? '').replace(/[\\`*_{}[\]()#+.!<>-]/gu, '\\$&');
    replacements.push({ start: node.position.start.offset, end: node.position.end.offset, text: resources[reference] ? `![${escaped}](${resources[reference]})` : escaped });
  });
  for (const item of replacements.sort((a,b) => b.start-a.start)) text = text.slice(0,item.start)+item.text+text.slice(item.end);
  return text;
}
