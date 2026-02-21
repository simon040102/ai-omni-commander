import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { EventBus } from './EventBus.js';
import { EventTypes } from '@omni/shared';
import { safeReadJson } from '../utils/fileUtils.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('ContractWatcher');

/**
 * Watches .ai_context/api-contracts/ for file changes.
 * Emits events on the EventBus when contracts are modified.
 */
export class ContractWatcher {
  private watcher: FSWatcher | null = null;

  constructor(
    private contextDir: string,
    private eventBus: EventBus,
    private projectId: string,
  ) {}

  /** Start watching for contract file changes */
  start(): void {
    const contractsDir = path.join(this.contextDir, 'api-contracts');

    this.watcher = watch(contractsDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    this.watcher.on('change', async (filePath: string) => {
      await this.handleChange(filePath);
    });

    this.watcher.on('add', async (filePath: string) => {
      await this.handleChange(filePath);
    });

    logger.info({ dir: contractsDir }, 'Contract watcher started');
  }

  /** Stop watching */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      logger.info('Contract watcher stopped');
    }
  }

  private async handleChange(filePath: string): Promise<void> {
    if (!filePath.endsWith('.contract.json')) return;

    const entity = path.basename(filePath, '.contract.json');
    const contract = await safeReadJson(filePath);

    if (!contract) return;

    logger.info({ entity, filePath }, 'Contract file changed');

    await this.eventBus.emit({
      type: EventTypes.CONTRACT_UPDATED,
      source: 'contractWatcher',
      payload: { entity, contract, filePath },
      timestamp: new Date().toISOString(),
    });
  }
}
