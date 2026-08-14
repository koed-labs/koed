export const assertMemoryAnswerDetailModes = (responses, marker) => {
  const answerOnly = responses.answer_only;
  const withCitations = responses.with_citations;
  const withEvidence = responses.with_evidence;
  for (const [mode, response] of Object.entries(responses)) {
    if (!response || typeof response !== "object") {
      throw new Error(`memory_answer ${mode} returned no structured response.`);
    }
    if (
      typeof response.markdown !== "string" ||
      !response.markdown.includes(marker)
    ) {
      throw new Error(
        `memory_answer ${mode} did not answer with the smoke marker.`
      );
    }
    if (!response.localMemoryWorker || typeof response.retrieval !== "object") {
      throw new Error(
        `memory_answer ${mode} omitted worker or retrieval status.`
      );
    }
  }
  if (answerOnly.evidence !== undefined || answerOnly.citations !== undefined) {
    throw new Error("memory_answer answer_only leaked citations or evidence.");
  }
  if (withCitations.evidence !== undefined) {
    throw new Error("memory_answer with_citations leaked evidence.");
  }
  if (!Array.isArray(withCitations.citations)) {
    throw new Error("memory_answer with_citations omitted citations.");
  }
  if (
    !Array.isArray(withEvidence.evidence) ||
    withEvidence.evidence.length === 0
  ) {
    throw new Error("memory_answer with_evidence omitted recalled evidence.");
  }
  if (!JSON.stringify(withEvidence.evidence).includes(marker)) {
    throw new Error(
      "memory_answer with_evidence did not contain the smoke marker."
    );
  }
  return {
    answerOnlyKeys: Object.keys(answerOnly).sort(),
    citationCount: withCitations.citations.length,
    evidenceCount: withEvidence.evidence.length
  };
};

export const parseToolJson = (result, mode) => {
  const text = result?.content?.find((item) => item?.type === "text")?.text;
  if (typeof text !== "string") {
    throw new Error(`memory_answer ${mode} returned no text content.`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`memory_answer ${mode} returned invalid JSON: ${text}`, {
      cause: error
    });
  }
};
