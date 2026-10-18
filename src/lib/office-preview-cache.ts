import type { AgentWorkspaceBinding } from './agent-types';
import type { FileBytesInput } from './file-types';
import type { OfficeModel } from './office-types';

/** Display snapshots only. ProjectFileContent revalidates File ownership/hash before use;
 * native save always validates the original again. Never cache a renderer or capability. */
class OfficePreviewCache {
  private scope = '';
  private models = new Map<string,string>();
  private size = 0;
  private readonly budget = 16 * 1024 * 1024;
  clear() { this.models.clear(); this.size = 0; this.scope = ''; }
  private key(binding: AgentWorkspaceBinding, input: FileBytesInput) {
    const scope = JSON.stringify([binding.workspaceId,binding.generation]);
    if (this.scope !== scope) { this.clear(); this.scope = scope; }
    return JSON.stringify([input.object,input.versionNumber,input.expectedContentHash]);
  }
  get(binding: AgentWorkspaceBinding,input: FileBytesInput): OfficeModel | undefined {
    const key = this.key(binding,input), json = this.models.get(key);
    if (json === undefined) return undefined;
    this.models.delete(key); this.models.set(key,json);
    return JSON.parse(json) as OfficeModel;
  }
  remember(binding: AgentWorkspaceBinding,input: FileBytesInput,model: OfficeModel) {
    const key = this.key(binding,input), json = JSON.stringify(model), size = json.length * 2;
    if (size > this.budget) return;
    const old = this.models.get(key);
    if (old !== undefined) { this.size -= old.length * 2; this.models.delete(key); }
    while (this.models.size && (this.size + size > this.budget || this.models.size >= 4)) {
      const oldest = this.models.keys().next().value!;
      this.size -= this.models.get(oldest)!.length * 2; this.models.delete(oldest);
    }
    this.models.set(key,json); this.size += size;
  }
}
export const officePreviewCache = new OfficePreviewCache();
