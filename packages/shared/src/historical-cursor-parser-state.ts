type StoredValue = string | number | boolean;

export type HistoricalCursorParserState = Record<string, StoredValue>;

const stringOrBoolean = (value: unknown): value is StoredValue =>
  typeof value === "string" || typeof value === "boolean";

const recordOrdinal = (value: unknown): value is StoredValue =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// The parser state an importer resumes from is stored with the historical
// cursor and returned to the importer. Only the fields listed here are kept,
// each only in the form its check accepts, so the column is not free-form
// storage for content such as transcript text. A parser that needs another
// field across batches has to add it here, or every batch after the first
// resumes without it.
const storedFields: Record<string, (value: unknown) => value is StoredValue> = {
  activeTurnId: stringOrBoolean,
  currentTurnId: stringOrBoolean,
  lastEventTime: stringOrBoolean,
  assistantMessagePreference: stringOrBoolean,
  // Codex: the history mode and the subagent boundary come from the session
  // header, which only the first batch sees.
  historyMode: (value): value is StoredValue =>
    value === "legacy" || value === "paginated",
  subagentHistoryStartOrdinal: recordOrdinal,
  lastRecordOrdinal: recordOrdinal,
  approvalHelperConversation: (value): value is StoredValue => value === true
};

export const safeHistoricalCursorParserState = (
  state: Record<string, unknown> | null | undefined
): HistoricalCursorParserState => {
  const safe: HistoricalCursorParserState = {};
  for (const [key, accepts] of Object.entries(storedFields)) {
    const value = state?.[key];
    if (accepts(value)) safe[key] = value;
  }
  return safe;
};
