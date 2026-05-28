import type { ToolChoiceCase } from "./benchmark.js";

const runs = 5;

export const toolChoiceCases: ToolChoiceCase[] = [
  {
    id: "project-prior-decision",
    prompt:
      "Before I change the auth setup again, remind me what we decided about API tokens in this project.",
    runs,
    expected: {
      shouldCallMemory: true,
      maxMemoryCalls: 1,
      searchDomain: { ideal: ["project"], acceptable: ["global"] },
      responseDetail: {
        ideal: ["answer_only"],
        acceptable: ["with_citations"]
      },
      includeEvidence: { ideal: [false] }
    },
    fakeMemoryAnswer: {
      memoryStatus: "found",
      markdown:
        "We decided API tokens are user-owned and personal-memory only in the current build."
    },
    notes:
      "Tests project-history and decision recall. Project is ideal because the prompt says this project."
  },
  {
    id: "global-cross-project-topic",
    prompt:
      "Have we ever discussed Aston Villa anywhere, or am I making that up?",
    runs,
    expected: {
      shouldCallMemory: true,
      maxMemoryCalls: 1,
      searchDomain: { ideal: ["global"], acceptable: ["project"] },
      responseDetail: {
        ideal: ["answer_only"],
        acceptable: ["with_citations"]
      },
      includeEvidence: { ideal: [false] }
    },
    fakeMemoryAnswer: {
      memoryStatus: "found",
      markdown: "Yes. Aston Villa came up in an earlier conversation."
    },
    notes:
      "Tests broad cross-session recall. Global is ideal because the prompt says anywhere."
  },
  {
    id: "remembered-user-preference",
    prompt:
      "Can you format this the way I usually like, or do you not know my preference?",
    runs,
    expected: {
      shouldCallMemory: true,
      maxMemoryCalls: 1,
      searchDomain: { ideal: ["project"], acceptable: ["global"] },
      responseDetail: {
        ideal: ["answer_only"],
        acceptable: ["with_citations"]
      },
      includeEvidence: { ideal: [false] }
    },
    fakeMemoryAnswer: {
      memoryStatus: "found",
      markdown:
        "The user prefers direct, concise engineering prose with minimal fluff."
    },
    notes:
      "Tests remembered preferences without an explicit 'search memory' instruction."
  },
  {
    id: "session-specific-recap",
    prompt:
      "Can you look back in the saved Codex session we were just working in and remind me what I asked you to check just before the CI failure?",
    runs,
    expected: {
      shouldCallMemory: true,
      maxMemoryCalls: 1,
      searchDomain: { ideal: ["session"], acceptable: ["project"] },
      responseDetail: {
        ideal: ["answer_only"],
        acceptable: ["with_citations"]
      },
      includeEvidence: { ideal: [false] }
    },
    fakeMemoryAnswer: {
      memoryStatus: "found",
      markdown:
        "You asked for KOE-99 suggestions and then asked about the argument limits for memory_answer."
    },
    notes:
      "Tests session-like recall wording without implying the fresh eval turn itself has prior visible context. A live runner should provide a backend session_id when available."
  },
  {
    id: "current-task-no-memory-needed",
    prompt:
      "Rename the local variable `payload` to `requestBody` in the function I just showed you.",
    runs,
    expected: {
      shouldCallMemory: false
    },
    fakeMemoryAnswer: {
      memoryStatus: "not_found",
      markdown: "No matching memory found."
    },
    notes:
      "Tests that current-context code editing does not trigger memory just because a tool exists."
  },
  {
    id: "public-fact-no-memory-needed",
    prompt: "What is the capital of Bhutan?",
    runs,
    expected: {
      shouldCallMemory: false
    },
    fakeMemoryAnswer: {
      memoryStatus: "not_found",
      markdown: "No matching memory found."
    },
    notes:
      "Tests that generic world knowledge does not trigger personal memory."
  },
  {
    id: "not-found-do-not-repeat",
    prompt:
      "Did I ever tell you the codename for the billing dashboard? If not, just say you don't know.",
    runs,
    expected: {
      shouldCallMemory: true,
      maxMemoryCalls: 1,
      searchDomain: { ideal: ["project"], acceptable: ["global"] },
      responseDetail: {
        ideal: ["answer_only"],
        acceptable: ["with_citations"]
      },
      includeEvidence: { ideal: [false] }
    },
    fakeMemoryAnswer: {
      memoryStatus: "not_found",
      markdown: "No matching memory found."
    },
    notes:
      "Tests not-found behavior and whether the agent avoids repeated memory calls."
  },
  {
    id: "explicit-citations-needed",
    prompt:
      "What did we decide about Docker Desktop versus WSL2? I need the answer with enough source detail to verify it.",
    runs,
    expected: {
      shouldCallMemory: true,
      maxMemoryCalls: 1,
      searchDomain: { ideal: ["project"], acceptable: ["global"] },
      responseDetail: {
        ideal: ["with_citations"],
        acceptable: ["with_evidence"]
      },
      includeEvidence: { ideal: [false], acceptable: [true] }
    },
    fakeMemoryAnswer: {
      memoryStatus: "found",
      markdown:
        "We decided Docker Desktop should run the containers while WSL2 Codex hooks trigger capture."
    },
    notes:
      "Tests that source-detail wording can justify citations without defaulting to full evidence."
  }
];
