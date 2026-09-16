/**
 * Minimal type surface for parquetjs (no official @types package).
 * Covers only what the lake landing-zone writer uses.
 */
declare module 'parquetjs' {
  export interface ParquetFieldDefinition {
    type: string;
    optional?: boolean;
    compression?: string;
    repeated?: boolean;
  }

  export class ParquetSchema {
    constructor(schema: Record<string, ParquetFieldDefinition>);
  }

  export class ParquetWriter {
    static openFile(schema: ParquetSchema, path: string, opts?: any): Promise<ParquetWriter>;
    static openStream(schema: ParquetSchema, outputStream: any, opts?: any): Promise<ParquetWriter>;
    appendRow(row: Record<string, any>): Promise<void>;
    close(): Promise<void>;
    setMetadata(key: string, value: string): void;
    setRowGroupSize(rows: number): void;
  }

  export class ParquetReader {
    static openFile(path: string): Promise<ParquetReader>;
    getCursor(columns?: string[][]): any;
    close(): Promise<void>;
  }

  const parquet: {
    ParquetSchema: typeof ParquetSchema;
    ParquetWriter: typeof ParquetWriter;
    ParquetReader: typeof ParquetReader;
  };
  export default parquet;
}
