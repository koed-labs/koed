import type { ManagedConversationRuntimeItem } from "../../../ipc/managed-conversation-protocol.js";

type Response = {
  decision?: "accept" | "acceptForSession" | "decline" | "cancel";
  answers?: Record<string, string[]>;
};

const text = (value: unknown) =>
  typeof value === "string" ? value.slice(0, 16_384) : "";

export function HqRuntimeItem({
  item,
  busy,
  onRespond
}: {
  item: ManagedConversationRuntimeItem;
  busy: boolean;
  onRespond: (response: Response) => void;
}) {
  if (item.state !== "pending" || item.answered) return null;
  if (
    item.itemKind === "user_input" &&
    item.presentation.renderer === "user_input"
  ) {
    const questions = Array.isArray(item.payload.questions)
      ? item.payload.questions.filter(
          (value): value is Record<string, unknown> =>
            Boolean(value && typeof value === "object" && !Array.isArray(value))
        )
      : [];
    return (
      <section className="hq-runtime-item" aria-label="AI Client question">
        <strong>The AI Client needs input</strong>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            const answers: Record<string, string[]> = {};
            for (const question of questions) {
              const id = text(question.id);
              if (!id) continue;
              const answer = String(values.get(id) ?? "");
              const options = Array.isArray(question.options)
                ? question.options
                    .map((value) =>
                      value && typeof value === "object"
                        ? text((value as Record<string, unknown>).label)
                        : ""
                    )
                    .filter(Boolean)
                : [];
              answers[id] = [
                question.isOther === true && !options.includes(answer)
                  ? `user_note: ${answer}`
                  : answer
              ];
            }
            onRespond({ answers });
          }}
        >
          {questions.map((question, index) => {
            const id = text(question.id) || `question-${index}`;
            const options = Array.isArray(question.options)
              ? question.options.filter(
                  (value): value is Record<string, unknown> =>
                    Boolean(
                      value &&
                      typeof value === "object" &&
                      text((value as Record<string, unknown>).label)
                    )
                )
              : [];
            return (
              <label key={id}>
                <span>
                  {text(question.header) ||
                    text(question.question) ||
                    "Response"}
                </span>
                {text(question.header) && text(question.question) ? (
                  <small>{text(question.question)}</small>
                ) : null}
                {options.length && question.isOther !== true ? (
                  <select defaultValue="" name={id} required>
                    <option disabled value="">
                      Select an answer
                    </option>
                    {options.map((option) => (
                      <option
                        key={text(option.label)}
                        value={text(option.label)}
                      >
                        {text(option.label)}
                        {text(option.description)
                          ? ` — ${text(option.description)}`
                          : ""}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    name={id}
                    required
                    type={question.isSecret === true ? "password" : "text"}
                    list={options.length ? `${id}-options` : undefined}
                  />
                )}
                {options.length && question.isOther === true ? (
                  <datalist id={`${id}-options`}>
                    {options.map((option) => (
                      <option
                        key={text(option.label)}
                        value={text(option.label)}
                      />
                    ))}
                  </datalist>
                ) : null}
              </label>
            );
          })}
          <button disabled={busy} type="submit">
            Submit
          </button>
        </form>
      </section>
    );
  }
  if (item.presentation.renderer !== "approval") return null;
  const command = Array.isArray(item.payload.command)
    ? item.payload.command.map(String).join(" ")
    : text(item.payload.command);
  const tool = text(item.payload.toolName);
  const details =
    tool && item.payload.input && typeof item.payload.input === "object"
      ? JSON.stringify(item.payload.input, null, 2).slice(0, 16_384)
      : "";
  return (
    <section className="hq-runtime-item" aria-label="AI Client approval">
      <strong>
        {item.itemKind === "file_approval"
          ? "Approve file changes?"
          : item.itemKind === "permissions_approval"
            ? "Approve permissions?"
            : "Approve command?"}
      </strong>
      {command ? <code>{command}</code> : null}
      {tool ? <code>Tool: {tool}</code> : null}
      {details ? <pre>{details}</pre> : null}
      {text(item.payload.cwd) ? (
        <code>Working directory: {text(item.payload.cwd)}</code>
      ) : null}
      {text(item.payload.grantRoot) ? (
        <code>Grant root: {text(item.payload.grantRoot)}</code>
      ) : null}
      {item.itemKind === "permissions_approval" && item.payload.permissions ? (
        <code>
          Permissions:{" "}
          {JSON.stringify(item.payload.permissions).slice(0, 16_384)}
        </code>
      ) : null}
      {text(item.payload.reason) ? <p>{text(item.payload.reason)}</p> : null}
      <div className="hq-runtime-item__actions">
        <button
          disabled={busy}
          onClick={() => onRespond({ decision: "decline" })}
          type="button"
        >
          Deny
        </button>
        <button
          disabled={busy}
          onClick={() => onRespond({ decision: "accept" })}
          type="button"
        >
          Approve
        </button>
        {item.payload.supportsSessionApproval === true ? (
          <button
            disabled={busy}
            onClick={() => onRespond({ decision: "acceptForSession" })}
            type="button"
          >
            Always allow this session
          </button>
        ) : null}
        <button
          disabled={busy}
          onClick={() => onRespond({ decision: "cancel" })}
          type="button"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
