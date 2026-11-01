import type {FileWorkingOpen, FileWorkingStatus, FileWorkingSaved, FileWorkingSaveInput} from '../services/fileWorkingApi';

type SaveInput<Edit> = FileWorkingSaveInput & {edits: Edit[]; requestId: string};
export interface SavedFileEdits<Edit> {receipt: FileWorkingSaved; editRevision: number; edits: Edit[]}

/** A live editor keeps its original model and cumulative journal. Only the
 * native working revision advances; published history is a separate concern. */
export class FileEditSession<Model, Edit> {
  private working: FileWorkingStatus | undefined;
  private edits: Edit[] = [];
  private signature = '[]';
  private editRevision = 0;
  private savedEditRevision = 0;
  private attempt: {input: SaveInput<Edit>; editRevision: number} | undefined;
  private saving: Promise<SavedFileEdits<Edit> | undefined> | undefined;

  constructor(private readonly opened: FileWorkingOpen | undefined, private readonly model: Model,
    private readonly persist: (input: SaveInput<Edit>) => Promise<FileWorkingSaved>) {
    this.working = opened;
  }
  get snapshot() {
    return {model:this.model, edits:this.edits, working:this.working, dirty:this.editRevision !== this.savedEditRevision,
      saving:!!this.saving, editRevision:this.editRevision, savedEditRevision:this.savedEditRevision};
  }
  replaceEdits(edits: Edit[], snapshot?: {editRevision: number}) {
    const signature = JSON.stringify(edits);
    if (signature === this.signature) return;
    this.signature = signature;
    this.edits = structuredClone(edits);
    this.editRevision = snapshot?.editRevision ?? this.editRevision + 1;
  }
  acknowledgeStatus(status: FileWorkingStatus) {
    if (this.working?.revision === status.revision && this.working.contentHash === status.contentHash) this.working = status;
  }
  save(): Promise<SavedFileEdits<Edit> | undefined> {
    if (this.saving) return this.saving;
    if (!this.opened || !this.working || (!this.snapshot.dirty && !this.attempt)) return Promise.resolve(undefined);
    // A failed request may have reached disk. Replay its exact identity and
    // payload before attempting newer input against the resulting revision.
    this.attempt ??= {editRevision:this.editRevision,input:{object:this.opened.object,sessionId:this.opened.sessionId,
      expectedRevision:this.working.revision,expectedContentHash:this.working.contentHash,
      edits:structuredClone(this.edits),requestId:crypto.randomUUID()}};
    const attempt = this.attempt;
    this.saving = this.persist(attempt.input).then(receipt => {
      this.working = receipt;
      this.savedEditRevision = attempt.editRevision;
      this.attempt = undefined;
      return {receipt,editRevision:attempt.editRevision,edits:attempt.input.edits};
    }).finally(() => {this.saving = undefined;});
    return this.saving;
  }
}
