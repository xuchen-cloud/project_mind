import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../../src/styles/app.css';
import { PptxEditor, type PptxEdit, type PptxModel } from '../../../../src/components/office/PptxEditor';

const initial: PptxModel = await (await fetch('/model')).json();
function Harness() {
  const [model, setModel] = useState(initial);
  const [edits, onChange] = useState<PptxEdit[]>([]);
  const [readOnly, setReadOnly] = useState(false);
  (window as any).officePptxHarness = {
    edits: () => edits, setReadOnly,
    async save() {
      const response = await fetch('/save', { method: 'POST', body: JSON.stringify({ edits }) });
      if (!response.ok) throw Error(await response.text());
      const committed = await response.json(); setModel(committed); onChange([]); return committed;
    },
  };
  return <PptxEditor model={model} edits={edits} onChange={onChange} readOnly={readOnly} />;
}
document.body.style.margin = '0';
document.getElementById('root')!.style.height = '100dvh';
createRoot(document.getElementById('root')!).render(<Harness />);
