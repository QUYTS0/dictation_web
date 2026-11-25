"use client";

import { AddVideoForm } from "@/components/AddVideoForm";
import { HERO_SURFACE_STYLE } from "./DashboardHero";

const STEPS = [
  { title: "Listen", detail: "Play the video one sentence at a time." },
  { title: "Type what you hear", detail: "Check every answer word by word." },
  { title: "Repeat aloud", detail: "Shadow the speaker and get a pronunciation score." },
] as const;

/**
 * The Dashboard for a learner with nothing yet — no videos, no study
 * sessions, no saved words (plan §4.5.3). One job: paste a link. Every other
 * card stays hidden until there's data to show. The field is not
 * autofocused: on page load that would skip the heading for screen-reader
 * users and pop the keyboard on phones.
 */
export function FirstRunHero({ url, onUrlChange }: { url: string; onUrlChange: (url: string) => void }) {
  return (
    <section
      data-testid="first-run"
      aria-labelledby="first-run-heading"
      className="relative overflow-hidden rounded-2xl p-6 text-white shadow-md sm:p-10"
      style={HERO_SURFACE_STYLE}
    >
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h1 id="first-run-heading" className="text-2xl font-extrabold tracking-tight sm:text-3xl">
            Welcome to DictaLearn
          </h1>
          <p className="mt-2 text-sm text-slate-300 sm:text-base">Paste a YouTube link to start your first practice.</p>
        </div>
        <AddVideoForm url={url} onUrlChange={onUrlChange} variant="dark" inputId="add-video-url" />
        <ol aria-label="How it works" className="grid gap-3 sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-3">
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-600 font-mono text-xs font-bold"
                aria-hidden="true"
              >
                {i + 1}
              </span>
              <div>
                <p className="text-sm font-semibold">{step.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-slate-300">{step.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
