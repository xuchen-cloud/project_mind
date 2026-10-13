import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../../src/styles/app.css';
import { PptxEditor, type PptxEdit } from '../../../../src/components/office/PptxEditor';
import model from './model.json';

function Harness() {
  const [edits, onChange] = useState<PptxEdit[]>([]);
  return <PptxEditor model={model} edits={edits} onChange={onChange} readOnly={false} />;
}
document.body.style.margin = '0';
document.getElementById('root')!.style.height = '100dvh';
createRoot(document.getElementById('root')!).render(<Harness />);
