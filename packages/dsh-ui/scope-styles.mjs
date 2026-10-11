import fs from 'node:fs/promises';
import postcss from 'postcss';

const names = ['base', 'corner-shape', 'design-platform', 'focus', 'onboarding', 'scrollbar', 'gradient-shadow-text', 'shiki'];
/** Scope original theme rules without changing declarations or component CSS modules. */
export function scopeTheme(css) {
  const sheet = postcss.parse(css);
  sheet.walkRules(rule => {
    if (rule.parent?.type === 'atrule' && /keyframes$/u.test(rule.parent.name)) return;
    rule.selectors = rule.selectors.map(selector => {
      let scoped = selector.replace(/:root\b/gu, '.dsh-ui-host').replace(/\bbody\b/gu, '.dsh-ui-host');
      // Platform and input-modality selectors remain on their original HTML ancestor.
      if (!scoped.includes('.dsh-ui-host')) scoped = '.dsh-ui-host ' + scoped;
      return scoped;
    });
  });
  return sheet.toString();
}

export async function generateScopedStyles() {
  const parts = await Promise.all(names.map(async name => {
    const css = await fs.readFile(new URL(`./upstream/client/ui-theme/src/styles/${name}.css`, import.meta.url), 'utf8');
    return `/* Upstream ui-theme/${name}.css; selectors scoped to the native host. */\n${scopeTheme(css)}`;
  }));
  await fs.mkdir(new URL('./styles/', import.meta.url), { recursive: true });
  await fs.writeFile(new URL('./styles/scoped.css', import.meta.url), parts.join('\n\n'));
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) await generateScopedStyles();
