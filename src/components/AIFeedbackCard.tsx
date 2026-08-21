import type { SessionExplainAllItem } from "@/lib/types";

interface AIFeedbackCardProps {
  feedback: SessionExplainAllItem;
  /** Called with the referenced sentence's segment index when a "duplicate" card is clicked. */
  onJumpToDuplicate?: (segmentIndex: number) => void;
}

/** Read-only display for an already-generated AI explanation — no fetching of its own. */
export default function AIFeedbackCard({ feedback, onJumpToDuplicate }: AIFeedbackCardProps) {
  if (feedback.status === "minor") {
    return (
      <p className="mt-1.5 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs text-slate-500">
        <span aria-hidden="true">◦ </span>
        {feedback.note ?? "A minor slip, not a language issue."}
      </p>
    );
  }

  if (feedback.status === "duplicate") {
    const targetSegment = feedback.duplicateOfSegmentIndex;
    return (
      <button
        type="button"
        onClick={() => targetSegment !== undefined && onJumpToDuplicate?.(targetSegment)}
        disabled={targetSegment === undefined}
        className="mt-1.5 flex w-full items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1.5 text-left text-xs text-slate-600 transition-colors hover:bg-slate-200 disabled:cursor-default disabled:hover:bg-slate-100"
      >
        <span aria-hidden="true">🔁</span>
        <span>{feedback.note ?? "Same mistake as an earlier sentence"}</span>
        {targetSegment !== undefined && (
          <span className="font-semibold text-primary-600">— jump to Sentence {targetSegment + 1}</span>
        )}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-violet-300 bg-violet-50 p-4 text-sm text-violet-900">
      <span className="text-xs font-semibold uppercase tracking-wide text-violet-700">
        <span aria-hidden="true">🤖 </span>AI Tutor
      </span>
      <p className="font-medium">{feedback.explanation}</p>

      <div className="flex flex-col gap-1 rounded-lg border border-violet-200 bg-white p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-violet-500">Correct version</p>
        <p className="font-mono font-semibold text-emerald-700">{feedback.correctedText}</p>
      </div>

      {feedback.example && (
        <div className="flex flex-col gap-1 rounded-lg border border-violet-200 bg-white p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-violet-500">Example</p>
          <p className="font-mono text-blue-700">{feedback.example}</p>
        </div>
      )}

      {feedback.tip && <p className="text-xs italic text-violet-600">💡 {feedback.tip}</p>}
    </div>
  );
}
