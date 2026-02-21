export interface ApiEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  description?: string;
  request?: {
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
  };
  response?: Record<string, unknown>;
}

export interface ApiContract {
  entity: string;
  basePath: string;
  endpoints: ApiEndpoint[];
  updatedAt: string;
  updatedBy: string;
}

export interface SchemaEntity {
  name: string;
  fields: SchemaField[];
}

export interface SchemaField {
  name: string;
  type: string;
  nullable?: boolean;
  primaryKey?: boolean;
  references?: string;
  defaultValue?: string;
}

export interface SchemaSnapshot {
  entities: SchemaEntity[];
  updatedAt: string;
  updatedBy: string;
}

export interface ContextEvent {
  type: string;
  source: string;
  target?: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface ContextManifest {
  contracts: string[];
  schema: string | null;
  lastUpdated: string;
}
