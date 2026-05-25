import type * as vscode from 'vscode';
import type { StoredDeployment } from '../studio/types';

const KEY = 'acurast.deployments.v1';

export class DeploymentStore {
  constructor(private readonly globalState: vscode.Memento) {}

  getAll(): StoredDeployment[] {
    return this.globalState.get<StoredDeployment[]>(KEY) ?? [];
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
