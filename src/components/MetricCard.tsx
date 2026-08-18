"use client";

import { ReactNode } from "react";
import clsx from "clsx";

interface MetricCardProps {
  title: string;
  value: string;
  icon: ReactNode;
  trend?: string;
  positive?: boolean;
}

export default function MetricCard({ title, value, icon, trend, positive }: MetricCardProps) {
  return (
    <div className="flex flex-col rounded-3xl border border-white/60 bg-white/50 p-5 shadow-xl transition-all hover:-translate-y-1 backdrop-blur-md">
      <div className="mb-2 flex items-start justify-between">
        <div className="text-slate-500">{icon}</div>
        {trend && (
          <div
            className={clsx(
              "rounded-full px-2 py-0.5 text-[10px] font-bold",
              positive ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-600"
            )}
          >
            {trend}
          </div>
        )}
      </div>
      <div className="mt-auto">
        <div className="text-2xl font-semibold tracking-tight text-slate-900">{value}</div>
        <div className="mt-0.5 text-xs font-medium uppercase text-slate-500">{title}</div>
      </div>
    </div>
  );
}
