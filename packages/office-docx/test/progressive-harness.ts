import {mountFullEditor} from '../full-editor';
import type {DocxModel, Edit} from '../types';
const state = window as any;
let model: DocxModel = await (await fetch('/model')).json(), edits: Edit[] = [];
let editRevision = 0, savedEditRevision = 0;
const errors: string[] = [];
let presentationMode: 'edit' | 'preview' = new URLSearchParams(location.search).has('preview') ? 'preview' : 'edit';
const options = () => ({model, edits, savedEditRevision, presentationMode,
  onChange(next: Edit[], snapshot?: {editRevision: number}) { edits = next; editRevision = snapshot!.editRevision; controller.update(options()); },
  onError(message: string) { errors.push(message); }});
const controller = mountFullEditor(document.querySelector<HTMLElement>('#root')!, options(), '/word-renderer/renderer.html');
state.progressive = {controller, errors, ready: () => controller.ready,
  preview(value: boolean) { presentationMode = value ? 'preview' : 'edit'; controller.update(options()); },
  async save() {
    await controller.beforeSave?.();
    const response = await fetch('/save', {method: 'POST', body: JSON.stringify({edits})});
    if (!response.ok) throw Error(await response.text());
    model = await response.json(); savedEditRevision = editRevision; edits = [];
    controller.update(options());
  },
};
