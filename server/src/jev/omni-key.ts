// omni 版 jev MCP 專用：金鑰從 OmniCommander 全域設定讀。獨立發佈版（packages/jev-mcp）
// 不 import 這支——better-sqlite3 是原生模組，打包給別人裝最容易出事。
import Database from 'better-sqlite3';
import { getDbPath } from '../mcp/helpers.js';
import { resolveTypesafeApiKey, TYPESAFE_API_KEY_CONFIG } from '../utils/typesafe.js';

/** OmniCommander 全域設定（DB）優先、env TYPESAFE_API_KEY 備援——與 Web 設定頁同一套規則。DB 不在也能只靠 env 跑。 */
export function readOmniJevApiKey(): string {
  let dbKey = '';
  try {
    const db = new Database(getDbPath(), { readonly: true, fileMustExist: true });
    try {
      dbKey = (db.prepare('SELECT value FROM global_config WHERE key = ?').get(TYPESAFE_API_KEY_CONFIG) as { value: string } | undefined)?.value ?? '';
    } finally {
      db.close();
    }
  } catch { /* DB 不存在或還沒有 global_config → 只看 env */ }
  return resolveTypesafeApiKey(dbKey, process.env['TYPESAFE_API_KEY']).key;
}
