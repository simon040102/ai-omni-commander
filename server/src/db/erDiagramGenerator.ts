/**
 * Generates Mermaid erDiagram syntax from DbSchemaResult data.
 * Supports full diagram (all tables) and single-table diagram (one table + related tables).
 */
import type { DbSchemaResult, DbSchemaColumn, DbSchemaForeignKey } from '@omni/shared';

/** Map SQL data types to shorter display types for Mermaid */
function shortType(dataType: string): string {
  const t = dataType.toLowerCase();
  if (t.includes('int')) return 'int';
  if (t.includes('varchar') || t.includes('character varying') || t.includes('text') || t.includes('nvarchar')) return 'string';
  if (t.includes('bool')) return 'boolean';
  if (t.includes('timestamp') || t.includes('datetime')) return 'datetime';
  if (t.includes('date')) return 'date';
  if (t.includes('numeric') || t.includes('decimal') || t.includes('float') || t.includes('double') || t.includes('real')) return 'decimal';
  if (t.includes('uuid') || t.includes('uniqueidentifier')) return 'uuid';
  if (t.includes('json') || t.includes('jsonb')) return 'json';
  if (t.includes('bytea') || t.includes('binary') || t.includes('blob') || t.includes('varbinary')) return 'bytes';
  return t.replace(/\s+/g, '_');
}

/** Escape table/column names for Mermaid (replace spaces, special chars) */
function esc(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** Determine Mermaid relationship notation from FK cardinality */
function fkRelation(fk: DbSchemaForeignKey, columns: DbSchemaColumn[]): string {
  // Check if FK column is nullable → optional (o) vs mandatory (|)
  const col = columns.find(c => c.tableName === fk.tableName && c.columnName === fk.columnName);
  const nullable = col?.isNullable ?? true;
  // parent (referenced) side is always "one", child (FK) side is "many"
  return nullable ? '||--o{' : '||--|{';
}

/**
 * Generate full ER diagram with all tables and their relationships.
 */
export function generateFullERDiagram(schema: DbSchemaResult): string {
  const lines: string[] = ['erDiagram'];

  // Group columns by table
  const colsByTable = new Map<string, DbSchemaColumn[]>();
  for (const col of schema.columns) {
    const arr = colsByTable.get(col.tableName) || [];
    arr.push(col);
    colsByTable.set(col.tableName, arr);
  }

  // Add entity definitions
  for (const table of schema.tables) {
    const cols = colsByTable.get(table.name) || [];
    if (cols.length === 0) {
      lines.push(`    ${esc(table.name)} {`);
      lines.push('    }');
    } else {
      lines.push(`    ${esc(table.name)} {`);
      for (const col of cols) {
        const marker = col.isPrimaryKey ? 'PK' : col.isForeignKey ? 'FK' : '';
        const comment = col.comment ? ` "${col.comment}"` : '';
        lines.push(`        ${shortType(col.dataType)} ${esc(col.columnName)}${marker ? ` ${marker}` : ''}${comment}`);
      }
      lines.push('    }');
    }
  }

  // Add relationships
  for (const fk of schema.foreignKeys) {
    const rel = fkRelation(fk, schema.columns);
    const label = fk.constraintName.length > 30
      ? fk.columnName
      : fk.constraintName;
    lines.push(`    ${esc(fk.referencedTable)} ${rel} ${esc(fk.tableName)} : "${esc(label)}"`);
  }

  return lines.join('\n');
}

/**
 * Generate single-table ER diagram showing one table and all directly related tables.
 */
export function generateSingleTableERDiagram(schema: DbSchemaResult, tableName: string): string {
  // Find all related tables (tables that have FK to/from this table)
  const relatedTables = new Set<string>([tableName]);
  const relevantFks: DbSchemaForeignKey[] = [];

  for (const fk of schema.foreignKeys) {
    if (fk.tableName === tableName) {
      relatedTables.add(fk.referencedTable);
      relevantFks.push(fk);
    } else if (fk.referencedTable === tableName) {
      relatedTables.add(fk.tableName);
      relevantFks.push(fk);
    }
  }

  // Build a filtered schema with only related tables
  const filteredSchema: DbSchemaResult = {
    connectionId: schema.connectionId,
    tables: schema.tables.filter(t => relatedTables.has(t.name)),
    columns: schema.columns.filter(c => relatedTables.has(c.tableName)),
    foreignKeys: relevantFks,
    fetchedAt: schema.fetchedAt,
  };

  return generateFullERDiagram(filteredSchema);
}
