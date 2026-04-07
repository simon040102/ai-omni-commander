/** Database connection configuration stored in ProjectConfig */
export type DbType = 'postgresql' | 'mysql' | 'mssql';

export interface DbConnectionConfig {
  id: string;
  label: string;
  connectionString: string;
  dbType: DbType;
}

/** Default ports for each DB type */
export const DB_DEFAULT_PORTS: Record<DbType, number> = {
  postgresql: 5432,
  mysql: 3306,
  mssql: 1433,
};

/** Schema fetch result — tables, columns, foreign keys */
export interface DbSchemaTable {
  name: string;
  schema: string;
  rowCountEstimate?: number;
}

export interface DbSchemaColumn {
  tableName: string;
  columnName: string;
  dataType: string;
  isNullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  referencedTable?: string;
  referencedColumn?: string;
  ordinalPosition: number;
  comment?: string;
}

export interface DbSchemaForeignKey {
  constraintName: string;
  tableName: string;
  columnName: string;
  referencedTable: string;
  referencedColumn: string;
}

export interface DbSchemaResult {
  connectionId: string;
  tables: DbSchemaTable[];
  columns: DbSchemaColumn[];
  foreignKeys: DbSchemaForeignKey[];
  fetchedAt: string;
}
