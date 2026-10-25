import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export async function writeNotices(root, inputs, lock) {
  const pieces = [`Project Mind Office DOCX\nGenOffice ${lock.repository}@${lock.commit}\nUnmodified upstream public sources; Project Mind adapters are separate.\n`];
  for (const name of ['LICENSE', 'NOTICE']) pieces.push(`=== GenOffice ${name} ===\n${await readFile(resolve(root, name), 'utf8')}`);
  for (const name of ['LICENSE','NOTICE']) pieces.push(`=== Nothing1024/dsh-genoffice-engine@86e288908456be5d3b3cccc97e79708e4adf1bc4 ${name} ===\n${await readFile(resolve(root,'vendor-web',name),'utf8')}`);
  for (const row of lock.files.filter(row => /license|notice/i.test(row.path.split('/').at(-1)))) {
    if (row.path === 'LICENSE' || row.path === 'NOTICE') continue;
    pieces.push(`=== GenOffice ${row.path} ===\n${await readFile(resolve(root, 'upstream', row.path), 'utf8')}`);
  }
  pieces.push(`=== Project Mind print-only font derivatives ===\nRebuilt from pinned GenOffice OFL CFF subsets with fonttools 4.60.1, brotli 1.1.0 and zopfli 0.2.3.post1. TrueType quadratic outlines, curve error <= 0.0005 em; cmap/GID and horizontal/vertical advance metrics retained. Font names changed to Project Mind Word Print. See print-fonts/source-lock.json and prepare-print-fonts.py. Original screen fonts are unchanged.\n${await readFile(resolve(root,'print-fonts/LICENSE-OFL.txt'),'utf8')}`);
  // esbuild resolves symlinked dependencies outside root in isolated checkouts.
  const packages = [...new Set([...inputs].flatMap(input => {
    const match=input.match(/^(.*(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+))(?:\/|$)/);
    return match?[resolve(root,match[1])]:[];
  }))].sort();
  for (const dir of packages) {
    const pkg = JSON.parse(await readFile(resolve(dir, 'package.json'), 'utf8'));
    const name=pkg.name;
    pieces.push(`=== ${name}@${pkg.version} (${pkg.license ?? 'see license text'}) ===`);
    const files = (await readdir(dir)).filter(name => /^(licen[sc]e|notice|copying)([.-]|$)/i.test(name)).sort();
    // boolbase's 1.0.0 tarball declares ISC but omits its license file.
    // Preserve the upstream text from this immutable repository revision.
    if (!files.length && name === 'boolbase' && pkg.version === '1.0.0') {
      const source = 'https://github.com/fb55/boolbase/blob/54811f01c797a6bb1c263183ae90b7dd627e0638/LICENSE';
      const license = await readFile(resolve(root, 'licenses/boolbase-1.0.0-LICENSE'), 'utf8');
      if (createHash('sha256').update(license).digest('hex') !== 'cdf4d87ae0a6c160227263bf4e39a0a10e30e89ae7256e0f7ac7bde0836552c6') throw Error('boolbase license provenance mismatch');
      pieces.push(`--- ${source} ---\n${license}`);
      continue;
    }
    if (!files.length && name === 'saxes' && pkg.version === '6.0.0') {
      const license=await readFile(resolve(root,'licenses/saxes-6.0.0-LICENSE'),'utf8');
      if(createHash('sha256').update(license).digest('hex')!=='0fac2374380621b22e6b50451057721a9c52935b02d16d106a9f04897f061d0e')throw Error('saxes license provenance mismatch');
      pieces.push('--- https://github.com/lddubeau/saxes/blob/211fa0ebec9b628affc09219199639887174bfc3/LICENSE ---\n'+license);
      continue;
    }
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
