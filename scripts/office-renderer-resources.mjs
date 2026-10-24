import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, resolve, relative, extname, sep} from 'node:path';

const suffix = '?office-resource';
const virtualPrefix = '\0office-resource:';
const devPrefix = '/@office-renderer/';
const mime = {'.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf', '.otf':'font/otf', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png'};

/** Stage complete, separately cacheable renderer trees without importing them in the host JS graph. */
export function officeRendererResources() {
  const devFiles = new Map();
  let serving = false;
  return {
    name: 'office-renderer-resources',
    enforce: 'pre',
    configResolved(config) { serving = config.command === 'serve'; },
    resolveId(source, importer) {
      if (!source.endsWith(suffix)) return;
      // Virtual IDs become browser import URLs; native Windows separators would
      // be rewritten by URL parsing before this plugin sees the ID again.
      const entry = resolve(importer ? dirname(importer.split('?')[0]) : process.cwd(), source.slice(0, -suffix.length));
      return virtualPrefix + entry.split(sep).join('/') + '.js';
    },
    load(id) {
      if (!id.startsWith(virtualPrefix)) return;
      const entry = resolve(id.slice(virtualPrefix.length, -3));
      const directory = dirname(entry);
      const manifestPath = resolve(directory, 'renderer-resources.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (resolve(directory, manifest.entry) !== entry || !manifest.files.includes(manifest.entry)) throw new Error('Office renderer entry is absent from its resource manifest');
      this.addWatchFile(manifestPath);
      const files = manifest.files.map(name => {
        const path = resolve(directory, name);
        const within = relative(directory, path);
        if (!within || within === '..' || within.startsWith('..' + sep) || within.startsWith(sep)) throw new Error('Office renderer resource escapes its dist directory');
        this.addWatchFile(path);
        return {name: within.split(sep).join('/'), path, bytes: readFileSync(path)};
      });
      const hash = createHash('sha256');
      for (const file of files) hash.update(file.name).update('\0').update(file.bytes);
      const key = hash.digest('hex').slice(0, 16);
      const html = files.find(file => file.name === manifest.entry).bytes.toString('utf8');
      const hints = [
        ...[...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(match => [match[1], 'modulepreload', 'script']),
        ...[...html.matchAll(/<link\b[^>]*\brel=["']modulepreload["'][^>]*\bhref=["']([^"']+)["']/gi)].map(match => [match[1], 'modulepreload', 'script']),
        ...[...html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["']/gi)].map(match => [match[1], 'preload', 'style']),
      ];
      const moduleCode = url => `const url=${url};export default url;\nexport function preload(){const links=${JSON.stringify(hints)}.map(([path,rel,as])=>{const link=document.createElement('link');link.rel=rel;link.as=as;link.href=new URL(path,new URL(url,document.baseURI)).href;document.head.append(link);return link});return ()=>links.forEach(link=>link.remove());}\n`;
      if (serving) {
        for (const file of files) devFiles.set(key + '/' + file.name, file.path);
        return moduleCode(JSON.stringify(devPrefix + key + '/' + manifest.entry));
      }
      let entryReference;
      for (const file of files) {
        const reference = this.emitFile({type:'asset', fileName:`assets/office-${key}/${file.name}`, source:file.bytes});
        if (file.name === manifest.entry) entryReference = reference;
      }
      return moduleCode(`import.meta.ROLLUP_FILE_URL_${entryReference}`);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = devFiles.get((req.url ?? '').split('?')[0].slice(devPrefix.length));
        if (!(req.url ?? '').startsWith(devPrefix) || !path) return next();
        res.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(readFileSync(path));
      });
    },
  };
}
