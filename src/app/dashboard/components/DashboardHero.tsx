"use client";

import type { ReactNode, Ref } from "react";
import { Play } from "lucide-react";
import type { DashboardSummary } from "@/lib/types/learning";
import { StreakStatusLine } from "./StreakStatusLine";

/** The navy hero surface (reference "Approved DictaLearn" hero). */
export const HERO_SURFACE_STYLE = {
  background:
    "radial-gradient(ellipse 70% 55% at 88% 12%, rgba(91, 92, 226, 0.15) 0%, rgba(91, 92, 226, 0) 70%), linear-gradient(135deg, #151b35 0%, #1b2145 52%, #25285c 100%)",
  border: "1px solid rgba(221, 227, 239, 0.12)",
} as const;

interface DashboardHeroProps {
  name: string;
  summary: DashboardSummary | undefined;
  addOpen: boolean;
  onToggleAdd: () => void;
  addToggleRef: Ref<HTMLButtonElement>;
  /** The inline link box, rendered under the button while open. */
  addPanel: ReactNode;
}

/**
 * The returning learner's hero (plan §1, §4.5.1–2): welcome + streak status
 * on the left; on the right, today's panel. Phase 4 adds the weekly track and
 * today's target, Phase 5 the level bar. "Start today's practice" starts a
 * NEW video (an inline link box); resuming belongs to the Continue card.
 */
export function DashboardHero({ name, summary, addOpen, onToggleAdd, addToggleRef, addPanel }: DashboardHeroProps) {
  return (
    <section
      data-testid="dashboard-welcome"
      aria-labelledby="dashboard-welcome-heading"
      className="relative overflow-hidden rounded-2xl p-6 text-white shadow-md md:p-8"
      style={HERO_SURFACE_STYLE}
    >
      <div className="relative grid grid-cols-1 items-center gap-6 lg:grid-cols-12">
        <div className="min-w-0 space-y-3 lg:col-span-7">
          <h1 id="dashboard-welcome-heading" className="text-2xl font-extrabold tracking-tight text-white sm:text-3xl">
            Welcome back, {name}
          </h1>
          <StreakStatusLine summary={summary} />
        </div>

        <div className="min-w-0 space-y-4 rounded-xl border border-white/10 bg-white/[0.04] p-5 lg:col-span-5">
          <button
            ref={addToggleRef}
            type="button"
            onClick={onToggleAdd}
            aria-expanded={addOpen}
            aria-controls="add-video"
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-reward/40 bg-reward px-3 py-2.5 text-sm font-semibold tracking-wide text-hero shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_1px_2px_rgba(0,0,0,0.12)] transition-colors hover:bg-[#e2a544] active:scale-[0.99]"
          >
            <Play size={15} className="fill-current" aria-hidden="true" />
            Start today&apos;s practice
          </button>
          {addOpen && addPanel}
        </div>
      </div>
    </section>
  );
}
