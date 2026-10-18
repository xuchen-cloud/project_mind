/** Summarize the fixed acceptance cohort without launching an application. */
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute, resolve} from 'node:path';
import {summarizeAcceptance} from './acceptance-summary.mjs';

const root = process.env.OFFICE_PERF_EVIDENCE;
if (!root || !isAbsolute(root)) throw Error('Set absolute OFFICE_PERF_EVIDENCE');
const directories = [
  'native-acceptance-release-docx', 'native-acceptance-release-md',
  'native-acceptance-release-pptx', 'native-acceptance-release-pptx-fixed',
  'native-acceptance-dev-pptx-final', 'native-acceptance-release-pptx-stable',
  'native-acceptance-release-xlsx-final', 'native-acceptance-dev-xlsx-stable',
  'native-acceptance-dev-xlsx-final', 'native-app-workspace-final',
  'baseline-native-memory-docx-valid', 'after-native-word-memory-80-opens',
];
const results = [], screenshots = [];
for (const directory of directories) {
  results.push(await summarizeAcceptance(root, directory));
  for (const file of (await readdir(resolve(root, directory))).filter(name => /\.(jpg|png)$/.test(name)).sort()) {
    const bytes = await readFile(resolve(root, directory, file));
    screenshots.push({source: `${directory}/${file}`, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')});
  }
}
const evidence = {
  schemaVersion: 1, evidenceRoot: '$OFFICE_PERF_EVIDENCE',
  qualification: 'Functional evidence only; failed and over-budget reports retained. Screenshot filenames are not assertions; see coordinating report for invalid/HMR/width qualifications. Never pool these times into formal performance data.',
  finalFunctionalCohort: {
    docx: 'native-acceptance-release-docx', md: 'native-acceptance-release-md',
    pptx: 'native-acceptance-release-pptx-stable', xlsx: 'native-acceptance-dev-xlsx-final',
    pptxBuild: 'Native Actions release; retained PPT product bytes identical, rejected XLSX experiment unused',
    xlsxBuild: 'Native Development with restored retained renderer and HMR/watch disabled; not release performance evidence',
  },
  results, screenshots,
};
await writeFile(new URL('./native-acceptance-20261019.json', import.meta.url),
  JSON.stringify(evidence, (_key, value) => typeof value === 'string' ? value.replaceAll(root, '$OFFICE_PERF_EVIDENCE') : value) + '\n');
console.log(`Recorded ${results.reduce((n, row) => n + row.reports.length, 0)} reports and ${screenshots.length} screenshots`);
