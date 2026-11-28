import { describe, expect, it } from "vitest";
import { safeHistoricalCursorParserState } from "./historical-cursor-parser-state.js";

describe("safeHistoricalCursorParserState", () => {
  it("keeps the turn and event fields an importer resumes from", () => {
    const state = {
      activeTurnId: "turn-2",
      currentTurnId: "turn-1",
      lastEventTime: "2026-11-28T10:00:00.000Z",
      assistantMessagePreference: "response_item"
    };
    expect(safeHistoricalCursorParserState(state)).toEqual(state);
  });

  it("keeps the position in a paginated Codex history", () => {
    const state = {
      historyMode: "paginated",
      subagentHistoryStartOrdinal: 4,
      lastRecordOrdinal: 7,
      approvalHelperConversation: true
    };
    expect(safeHistoricalCursorParserState(state)).toEqual(state);
  });

  it("keeps a first record ordinal of zero", () => {
    expect(
      safeHistoricalCursorParserState({
        historyMode: "legacy",
        subagentHistoryStartOrdinal: 0,
        lastRecordOrdinal: 0
      })
    ).toEqual({
      historyMode: "legacy",
      subagentHistoryStartOrdinal: 0,
      lastRecordOrdinal: 0
    });
  });

  it("drops fields that are not resume state", () => {
    expect(
      safeHistoricalCursorParserState({
        currentTurnId: "turn-1",
        rawTranscript: "must-not-be-stored"
      })
    ).toEqual({ currentTurnId: "turn-1" });
  });

  it("drops a known field whose value has another form", () => {
    expect(
      safeHistoricalCursorParserState({
        activeTurnId: { text: "must-not-be-stored" },
        historyMode: "must-not-be-stored",
        subagentHistoryStartOrdinal: "4",
        lastRecordOrdinal: -1,
        approvalHelperConversation: "must-not-be-stored"
      })
    ).toEqual({});
    expect(
      safeHistoricalCursorParserState({
        subagentHistoryStartOrdinal: 1.5,
        lastRecordOrdinal: Number.MAX_SAFE_INTEGER + 1
      })
    ).toEqual({});
  });

  it("returns an empty state when none is stored", () => {
    expect(safeHistoricalCursorParserState(undefined)).toEqual({});
    expect(safeHistoricalCursorParserState(null)).toEqual({});
  });
});
