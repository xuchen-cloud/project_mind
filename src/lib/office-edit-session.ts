import type { FileBytesInput } from './file-types';
import type { DocumentVersionCommitResult } from './types';

export interface OfficeSaveResult<Model> { model: Model; commit: DocumentVersionCommitResult }
export type OfficeSaveInput<Edit> = FileBytesInput & { edits: Edit[]; requestId: string };
export class OfficeEditSession<Model, Edit> {
  private baseline: FileBytesInput;
  private model: Model;
  private edits: Edit[] = [];
  private requestId: string | null = null;
  private saving: Promise<OfficeSaveResult<Model> | undefined> | null = null;
  constructor(baseline: FileBytesInput, model: Model,
    private readonly persist: (input: OfficeSaveInput<Edit>) => Promise<OfficeSaveResult<Model>>) {
    this.baseline = baseline;
    this.model = model;
  }
  get snapshot() { return { baseline: this.baseline, model: this.model, edits: this.edits, saving: this.saving !== null }; }
  replaceEdits(edits: Edit[]) {
    if (this.saving) throw new Error('文件正在保存，请等待保存完成。');
    this.edits = structuredClone(edits);
    this.requestId = null;
  }
  save(): Promise<OfficeSaveResult<Model> | undefined> {
    if (this.saving) return this.saving;
    if (!this.edits.length) return Promise.resolve(undefined);
    this.requestId ??= crypto.randomUUID();
    const input = { ...this.baseline, edits: this.edits, requestId: this.requestId };
    this.saving = this.persist(input).then(result => {
      this.baseline = { ...this.baseline, versionNumber: result.commit.receipt.versionNumber,
        expectedContentHash: result.commit.receipt.contentHash };
      this.model = result.model;
      this.edits = [];
      this.requestId = null;
      return result;
    }).finally(() => { this.saving = null; });
    return this.saving;
  }
}
