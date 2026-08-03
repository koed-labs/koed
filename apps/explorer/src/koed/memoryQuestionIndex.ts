import { memoryQuestionPreview, memoryScopeLabel } from "./memory";
import type { GroupedMemoryQuestions, MemoryQuestionRecord } from "./types";

export function filterMemoryQuestions(
  questions: MemoryQuestionRecord[],
  query: string
) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return questions;
  }
  return questions.filter(
    (question) =>
      question.query.toLowerCase().includes(needle) ||
      memoryQuestionPreview(question).toLowerCase().includes(needle) ||
      memoryScopeLabel(question).toLowerCase().includes(needle)
  );
}

export function groupMemoryQuestions(
  questions: MemoryQuestionRecord[]
): GroupedMemoryQuestions {
  const projectMap = new Map<
    string,
    {
      id: string;
      name: string;
      projectQuestions: MemoryQuestionRecord[];
      sessionMap: Map<
        string,
        { id: string; name: string; questions: MemoryQuestionRecord[] }
      >;
    }
  >();

  for (const question of questions) {
    if (question.searchDomain === "global") {
      continue;
    }
    const projectId = question.projectId ?? "unknown-project";
    const project = projectMap.get(projectId) ?? {
      id: projectId,
      name: question.projectName ?? "Selected project",
      projectQuestions: [] as MemoryQuestionRecord[],
      sessionMap: new Map()
    };
    if (question.searchDomain === "session") {
      const sessionId = question.sessionId ?? question.threadId ?? question.id;
      const session = project.sessionMap.get(sessionId) ?? {
        id: sessionId,
        name: question.threadName ?? "Selected session",
        questions: [] as MemoryQuestionRecord[]
      };
      session.questions.push(question);
      project.sessionMap.set(session.id, session);
    } else {
      project.projectQuestions.push(question);
    }
    projectMap.set(project.id, project);
  }

  return {
    global: questions.filter((question) => question.searchDomain === "global"),
    projects: [...projectMap.values()].map((project) => ({
      id: project.id,
      name: project.name,
      projectQuestions: project.projectQuestions,
      sessions: [...project.sessionMap.values()]
    }))
  };
}

export function visibleMemoryQuestionIndex(
  questions: MemoryQuestionRecord[],
  query: string
) {
  return groupMemoryQuestions(filterMemoryQuestions(questions, query));
}
