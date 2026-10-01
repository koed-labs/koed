type PrepareTeamQuestionActionProps = {
  text: string;
  onPrepare: (text: string) => void;
};

export function PrepareTeamQuestionAction({
  text,
  onPrepare
}: PrepareTeamQuestionActionProps) {
  return (
    <button
      type="button"
      onClick={() => onPrepare(text)}
      className="mt-2 rounded-md border border-border px-2 py-1 text-[10px] text-subtle hover:bg-surface-hover"
    >
      Prepare Team question
    </button>
  );
}
