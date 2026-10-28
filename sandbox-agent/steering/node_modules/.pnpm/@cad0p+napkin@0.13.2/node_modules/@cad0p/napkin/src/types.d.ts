declare module "sql.js" {
  interface Database {
    run(sql: string, params?: unknown[]): void;
    exec(sql: string): { columns: string[]; values: unknown[][] }[];
    close(): void;
    // biome-ignore lint/complexity/noBannedTypes: sql.js dynamic function registration
    create_function(name: string, fn: Function): void;
  }
  interface SqlJsStatic {
    Database: new () => Database;
  }

  export type { Database };
  export default function initSqlJs(): Promise<SqlJsStatic>;
}

declare module "jexl" {
  class Jexl {
    eval(expr: string, context?: Record<string, unknown>): Promise<unknown>;
    // biome-ignore lint/complexity/noBannedTypes: jexl dynamic function registration
    addFunction(name: string, fn: Function): void;
    // biome-ignore lint/complexity/noBannedTypes: jexl dynamic transform registration
    addTransform(name: string, fn: Function): void;
  }
  export default { Jexl };
}
