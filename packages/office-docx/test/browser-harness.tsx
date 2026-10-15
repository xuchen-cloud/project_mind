import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DocxEditor } from '../../../src/components/office/DocxEditor';
import type { DocxModel, Edit } from '../types';

const initial = await (await fetch('/model')).json() as DocxModel;
function Harness() {
  const [model, setModel] = useState(initial);
  const [edits, setEdits] = useState<Edit[]>([]);
  const [readOnly, setReadOnly] = useState(new URLSearchParams(location.search).has('readOnly'));
  (window as any).officeDocxHarness = {
    edits: () => edits,
    setReadOnly,
    async save() {
      const response = await fetch('/save', { method: 'POST', body: JSON.stringify({ edits }), headers: { 'content-type': 'application/json' } });
      if (!response.ok) throw Error(await response.text());
      const result = await response.json();
      setModel(result.model); setEdits([]);
      return result.model;
    },
    rebase: () => { setModel(initial); setEdits([]); },
  };
  return <DocxEditor model={model} edits={edits} onChange={setEdits} readOnly={readOnly} />;
}
createRoot(document.querySelector('#root')!).render(<Harness />);
