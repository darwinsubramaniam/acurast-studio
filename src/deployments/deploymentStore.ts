import type * as vscode from 'vscode';
import type { StoredDeployment } from '../studio/types';

const KEY = 'acurast.deployments.v1';

export class DeploymentStore {
  constructor(private readonly globalState: vscode.Memento) {}

  getAll(): StoredDeployment[] {
    return this.globalState.get<StoredDeployment[]>(KEY) ?? [];
  }

  /**
   * True when `path` is the recorded `projectPath` of some stored deployment.
   * Guards `history.openFolder` so a webview message can only reveal a folder the
   * extension itself tracked, not an arbitrary filesystem path.
   */
  hasProjectPath(path: string): boolean {
    return this.getAll().some((r) => r.projectPath === path);
  }

  async save(record: StoredDeployment): Promise<void> {
    await this.globalState.update(KEY, [...this.getAll(), record]);
  }

  async removePathInfo(id: string): Promise<void> {
    await this.globalState.update(KEY,
      this.getAll().map((r) => r.id === id ? { ...r, projectPath: undefined } : r)
    );
  }

  async remove(id: string): Promise<void> {
    await this.globalState.update(KEY, this.getAll().filter((r) => r.id !== id));
  }
}
