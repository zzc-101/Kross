export interface QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount: number | null;
}

/** The structural subset of pg.PoolClient used by repositories and tests. */
export interface SqlExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<Row>>;
}

export interface SqlPool extends SqlExecutor {
  connect(): Promise<SqlClient>;
  end(): Promise<void>;
}

export interface SqlClient extends SqlExecutor {
  release(): void;
}

export class PostgresDatabase {
  public constructor(private readonly pool: SqlPool) {}

  public query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryResult<Row>> {
    return this.pool.query<Row>(text, values);
  }

  public async transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public close(): Promise<void> {
    return this.pool.end();
  }
}

export interface TransactionRunner {
  transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T>;
}
