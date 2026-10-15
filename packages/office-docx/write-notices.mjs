import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function writeNotices(root, inputs, lock) {
  const pieces = [`Project Mind Office DOCX\nGenOffice ${lock.repository}@${lock.commit}\nUnmodified upstream public sources; Project Mind adapters are separate.\n`];
  for (const name of ['LICENSE', 'NOTICE']) pieces.push(`=== GenOffice ${name} ===\n${await readFile(resolve(root, name), 'utf8')}`);
  for (const row of lock.files.filter(row => /license|notice/i.test(row.path.split('/').at(-1)))) {
    if (row.path === 'LICENSE' || row.path === 'NOTICE') continue;
    pieces.push(`=== GenOffice ${row.path} ===\n${await readFile(resolve(root, 'upstream', row.path), 'utf8')}`);
  }
  const packages = [...new Set([...inputs].filter(p => p.startsWith('node_modules/')).map(p => p.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/)[1]))].sort();
  for (const name of packages) {
    const dir = resolve(root, 'node_modules', name);
    const pkg = JSON.parse(await readFile(resolve(dir, 'package.json'), 'utf8'));
    pieces.push(`=== ${name}@${pkg.version} (${pkg.license ?? 'see license text'}) ===`);
    const files = (await readdir(dir)).filter(name => /^(licen[sc]e|notice|copying)([.-]|$)/i.test(name)).sort();
    // isarray@1.0.0 publishes its complete MIT text inside README.md.
    if (!files.length && name === 'isarray') {
      const readme = await readFile(resolve(dir, 'README.md'), 'utf8');
      const at = readme.indexOf('## License');
      if (at < 0) throw Error('Missing isarray README license');
      pieces.push(readme.slice(at));
      continue;
    }
    if (!files.length) throw Error(`Missing third-party license text for ${name}`);
    for (const file of files) pieces.push(`--- ${file} ---\n${await readFile(resolve(dir, file), 'utf8')}`);
  }
  await writeFile(resolve(root, 'dist/THIRD-PARTY-NOTICES.txt'), pieces.join('\n\n') + '\n');
}
