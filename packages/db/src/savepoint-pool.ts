import type pg from "pg";

const queryText = (
  input: string | { text: string } | undefined
): string | null => {
  if (typeof input === "string") return input;
  return input && typeof input.text === "string" ? input.text : null;
};

export const createSavepointPool = (
  client: pg.PoolClient,
  scope: "high_risk" | "curated_memory"
): pg.Pool => {
  let depth = 0;
  const emptyQueryResult = (): pg.QueryResult<pg.QueryResultRow> => ({
    command: "OK",
    rowCount: null,
    oid: 0,
    fields: [],
    rows: []
  });
  const savepointClient = {
    async query(
      ...args: Parameters<pg.PoolClient["query"]>
    ): Promise<pg.QueryResult<pg.QueryResultRow>> {
      const [input, params] = args;
      const text = queryText(input)?.trim().toLowerCase();
      const savepoint = `koed_${scope}_${depth}`;
      if (text === "begin") {
        depth += 1;
        await client.query(`savepoint koed_${scope}_${depth}`);
        return emptyQueryResult();
      }
      if (text === "commit") {
        if (depth > 0) {
          await client.query(`release savepoint ${savepoint}`);
          depth -= 1;
        }
        return emptyQueryResult();
      }
      if (text === "rollback") {
        if (depth > 0) {
          await client.query(`rollback to savepoint ${savepoint}`);
          depth -= 1;
        }
        return emptyQueryResult();
      }
      return params === undefined
        ? client.query(input as string)
        : client.query(input as string, params as never);
    },
    release() {}
  };

  return {
    connect: () => Promise.resolve(savepointClient as pg.PoolClient),
    query: (...args: Parameters<pg.Pool["query"]>) =>
      savepointClient.query(...(args as Parameters<pg.PoolClient["query"]>))
  } as unknown as pg.Pool;
};
