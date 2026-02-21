import path from 'node:path';
import type { ApiContract, SchemaSnapshot, ContextManifest } from '@omni/shared';
import { safeWriteJson, safeReadJson, listFiles, ensureDir } from '../utils/fileUtils.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('ContextSync');

/**
 * Manages the .ai_context/ shared folder for cross-agent communication.
 * This folder lives inside the target project's working directory.
 */
export class ContextSync {
  private contractsDir: string;
  private schemaDir: string;
  private eventsDir: string;
  private manifestPath: string;

  constructor(private contextDir: string) {
    this.contractsDir = path.join(contextDir, 'api-contracts');
    this.schemaDir = path.join(contextDir, 'db-schema');
    this.eventsDir = path.join(contextDir, 'events');
    this.manifestPath = path.join(contextDir, 'manifest.json');
  }

  /** Initialize the .ai_context directory structure */
  async init(): Promise<void> {
    await ensureDir(this.contractsDir);
    await ensureDir(this.schemaDir);
    await ensureDir(this.eventsDir);
    logger.info({ dir: this.contextDir }, '.ai_context initialized');
  }

  /** Write or update an API contract */
  async writeApiContract(contract: ApiContract): Promise<void> {
    const filePath = path.join(this.contractsDir, `${contract.entity}.contract.json`);
    await safeWriteJson(filePath, contract);
    await this.updateManifest();
    logger.info({ entity: contract.entity }, 'API contract written');
  }

  /** Read a specific API contract */
  async readApiContract(entity: string): Promise<ApiContract | null> {
    const filePath = path.join(this.contractsDir, `${entity}.contract.json`);
    return safeReadJson<ApiContract>(filePath);
  }

  /** Read all API contracts */
  async readAllContracts(): Promise<ApiContract[]> {
    const files = await listFiles(this.contractsDir, f => f.endsWith('.contract.json'));
    const contracts: ApiContract[] = [];
    for (const file of files) {
      const contract = await safeReadJson<ApiContract>(path.join(this.contractsDir, file));
      if (contract) contracts.push(contract);
    }
    return contracts;
  }

  /** Write or update DB schema snapshot */
  async writeSchemaSnapshot(schema: SchemaSnapshot): Promise<void> {
    const filePath = path.join(this.schemaDir, 'schema.snapshot.json');
    await safeWriteJson(filePath, schema);
    await this.updateManifest();
    logger.info('DB schema snapshot written');
  }

  /** Read current DB schema */
  async readSchema(): Promise<SchemaSnapshot | null> {
    return safeReadJson<SchemaSnapshot>(path.join(this.schemaDir, 'schema.snapshot.json'));
  }

  /** Update the manifest.json index */
  async updateManifest(): Promise<void> {
    const contractFiles = await listFiles(this.contractsDir, f => f.endsWith('.contract.json'));
    const schemaExists = await safeReadJson(path.join(this.schemaDir, 'schema.snapshot.json'));

    const manifest: ContextManifest = {
      contracts: contractFiles,
      schema: schemaExists ? 'db-schema/schema.snapshot.json' : null,
      lastUpdated: new Date().toISOString(),
    };

    await safeWriteJson(this.manifestPath, manifest);
  }

  /** Get the context directory path */
  getDir(): string {
    return this.contextDir;
  }
}
