"use client";

interface VocabRowProps {
  word: string;
  context: string;
}

export default function VocabRow({ word, context }: VocabRowProps) {
  return (
    <tr className="group cursor-pointer transition-colors hover:bg-white/40">
      <td className="w-1/3 px-4 py-3 align-top">
        <div className="font-semibold text-slate-900">{word}</div>
      </td>
      <td className="px-4 py-3 align-top">
        <div className="line-clamp-2 text-xs italic text-slate-500 transition-colors group-hover:text-slate-700">
          &quot;{context}&quot;
        </div>
      </td>
    </tr>
  );
}
