import React from 'react';
import { Headphones, Flame, Trophy, TrendingUp, Clock, CheckCircle2, BookOpen, PlayCircle, Sparkles, ChevronRight, Calendar } from 'lucide-react';
import { motion } from 'motion/react';

export default function Dashboard({ onNavigate }: { onNavigate: (view: string) => void }) {
  // Generate dummy data for the heatmap (14 weeks)
  const weeks = Array.from({ length: 14 });
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const getActivityLevel = (week: number, day: number) => {
    const seed = (week * 7 + day) % 17;
    if (seed > 14) return 'bg-indigo-600';
    if (seed > 10) return 'bg-indigo-400';
    if (seed > 5) return 'bg-indigo-200 dark:bg-indigo-500/40';
    return 'bg-slate-100 dark:bg-slate-800';
  };

  return (
    <div className="flex-1 flex flex-col font-sans w-full">
      {/* Top Navbar */}
      <header className="px-6 py-4 flex items-center justify-between border-b border-white/40 dark:border-white/10 bg-white/30 dark:bg-slate-900/40 backdrop-blur-md sticky top-0 z-10 w-full">
        <div 
          onClick={() => onNavigate('landing')}
          className="flex items-center gap-2 cursor-pointer"
        >
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white">
            <Headphones size={18} />
          </div>
          <span className="font-semibold text-slate-900 dark:text-white tracking-tight text-lg">DictaLearn</span>
        </div>
        <div className="flex items-center gap-6">
          <nav className="hidden md:flex gap-6">
            <button onClick={() => onNavigate('dashboard')} className="text-sm font-bold text-indigo-600">Dashboard</button>
            <button onClick={() => onNavigate('vocabulary')} className="text-sm font-medium text-slate-500 dark:text-slate-400 hover:text-indigo-600 transition-colors">Vocabulary</button>
            <button onClick={() => onNavigate('history')} className="text-sm font-medium text-slate-500 dark:text-slate-400 hover:text-indigo-600 transition-colors">History</button>
            <button onClick={() => onNavigate('leaderboard')} className="text-sm font-medium text-slate-500 dark:text-slate-400 hover:text-indigo-600 transition-colors">Leaderboard</button>
          </nav>
          <div className="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-400 font-semibold text-sm border border-slate-300 dark:border-slate-700">
            T
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 py-8 flex flex-col gap-8 overflow-y-auto">
        
        {/* Welcome & Gamification Top Bar */}
        <section className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900 dark:text-white tracking-tight mb-1">Welcome back, Taylor</h1>
            <p className="text-slate-500 dark:text-slate-400 text-sm">You are on a 3-day learning streak. Keep it up!</p>
          </div>
          <div className="flex bg-white/60 dark:bg-slate-800/60 backdrop-blur-md rounded-2xl border border-white/80 dark:border-white/10 shadow-md p-2 gap-2">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-orange-50 dark:bg-orange-500/10 text-orange-600 dark:text-orange-400 rounded-lg shrink-0">
              <Flame size={18} className="fill-orange-500/20" />
              <span className="font-semibold text-sm">3 Days</span>
            </div>
            <div className="w-px bg-slate-200 dark:bg-slate-700 my-1 mx-1"></div>
            <div className="flex items-center gap-2 px-3 py-1.5 bg-yellow-50 dark:bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 rounded-lg shrink-0">
              <Trophy size={18} className="fill-yellow-500/20" />
              <span className="font-semibold text-sm">Silver Badge</span>
            </div>
          </div>
        </section>

        {/* Metrics Overview */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard title="Completed Videos" value="12" icon={<PlayCircle size={20} />} trend="+2 this week" />
          <MetricCard title="Avg. Accuracy" value="87%" icon={<CheckCircle2 size={20} />} trend="+5% this week" positive />
          <MetricCard title="Practice Time" value="2h 15m" icon={<Clock size={20} />} />
          <MetricCard title="Vocab Saved" value="124" icon={<BookOpen size={20} />} trend="+14 words" />
        </section>

        {/* Mastery Heatmap Section */}
        <section className="bg-white/40 dark:bg-slate-800/40 backdrop-blur-xl border border-white/60 dark:border-white/10 rounded-3xl p-6 shadow-xl">
           <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2 text-slate-900 dark:text-white">
                <Calendar size={18} className="text-indigo-500" />
                <h2 className="text-sm font-bold uppercase tracking-widest">Consistency Map</h2>
              </div>
              <div className="flex items-center gap-2">
                 <span className="text-[10px] uppercase font-bold text-slate-400 tracking-tighter">Less</span>
                 <div className="flex gap-1">
                    <div className="w-3 h-3 rounded-[2px] bg-slate-100 dark:bg-slate-800"></div>
                    <div className="w-3 h-3 rounded-[2px] bg-indigo-200 dark:bg-indigo-500/40"></div>
                    <div className="w-3 h-3 rounded-[2px] bg-indigo-400"></div>
                    <div className="w-3 h-3 rounded-[2px] bg-indigo-600"></div>
                 </div>
                 <span className="text-[10px] uppercase font-bold text-slate-400 tracking-tighter">More</span>
              </div>
           </div>
           
           <div className="flex gap-4">
              {/* Days label */}
              <div className="flex flex-col gap-1.5 justify-between py-1 pr-2">
                 {days.map((day, dIdx) => (
                   <span key={dIdx} className="text-[9px] font-black uppercase text-slate-400 tracking-tighter leading-none">{dIdx % 2 === 0 ? day : ''}</span>
                 ))}
              </div>
              {/* Grid */}
              <div className="flex-1 flex gap-1.5 overflow-x-auto pb-2 scrollbar-none">
                 {weeks.map((_, wIdx) => (
                   <div key={wIdx} className="flex flex-col gap-1.5 shrink-0">
                      {days.map((_, dIdx) => (
                        <div 
                          key={dIdx} 
                          className={`w-4 h-4 sm:w-5 sm:h-5 rounded-[4px] ${getActivityLevel(wIdx, dIdx)} transition-colors cursor-pointer hover:ring-2 hover:ring-indigo-500/40`}
                          title={`Week ${wIdx}, Day ${dIdx}`}
                        ></div>
                      ))}
                   </div>
                 ))}
              </div>
           </div>
           <div className="mt-4 flex items-center gap-2 text-[11px] font-medium text-slate-500 dark:text-slate-400">
              <TrendingUp size={14} className="text-indigo-500" />
              <span>Your activity is <span className="text-indigo-600 dark:text-indigo-400 font-bold">24% higher</span> than last month. Great job!</span>
           </div>
        </section>

        <div className="grid md:grid-cols-3 gap-8 items-start">
          
          {/* Main Left Column */}
          <div className="md:col-span-2 flex flex-col gap-8">
            
            {/* Start / Continue */}
            <section>
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white uppercase tracking-wider">Continue Learning</h2>
              </div>
              
              <div 
                className="group relative rounded-3xl overflow-hidden cursor-pointer shadow-xl border border-white/60 dark:border-white/10 bg-white/50 dark:bg-slate-800/40 backdrop-blur-md p-4 flex flex-col sm:flex-row gap-4 hover:-translate-y-1 transition-all"
                onClick={() => onNavigate('workspace')}
              >
                {/* Thumbnail Area */}
                <div className="relative w-full sm:w-48 aspect-video rounded-xl overflow-hidden bg-slate-800 shrink-0">
                  <img src="https://picsum.photos/seed/podcast/400/225" alt="Video thumbnail" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" referrerPolicy="no-referrer" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-10 h-10 rounded-full bg-white/30 backdrop-blur-md flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                      <PlayCircle className="text-white fill-white/20" size={24} />
                    </div>
                  </div>
                  <div className="absolute bottom-2 right-2 px-1.5 py-0.5 bg-black/70 text-white text-[10px] font-medium rounded">
                    12:40
                  </div>
                </div>
                
                {/* Info Area */}
                <div className="flex-1 flex flex-col justify-center">
                  <h3 className="font-semibold text-slate-900 dark:text-white mb-1 group-hover:text-indigo-600 transition-colors">English Podcast For Easy English Learning</h3>
                  <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">Speak English With Class</p>
                  
                  <div className="mt-auto">
                    <div className="flex justify-between text-xs text-slate-600 dark:text-slate-400 mb-1">
                      <span>45 / 88 Sentences</span>
                      <span className="font-medium">51%</span>
                    </div>
                    <div className="w-full bg-slate-100 dark:bg-slate-700 rounded-full h-1.5 overflow-hidden">
                      <div className="bg-indigo-500 h-full rounded-full" style={{ width: '51%' }}></div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Vocabulary Grid */}
            <section>
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white uppercase tracking-wider">Recent Vocabulary</h2>
                <button onClick={() => onNavigate('vocabulary')} className="text-sm text-indigo-600 dark:text-indigo-400 font-bold hover:text-indigo-700 flex items-center gap-1">
                  View all <ChevronRight size={16} />
                </button>
              </div>
              <div className="bg-white/50 dark:bg-slate-800/40 backdrop-blur-md border border-white/60 dark:border-white/10 rounded-3xl shadow-xl overflow-hidden">
                <table className="w-full text-left text-sm">
                  <thead className="bg-white/40 dark:bg-slate-900/40 border-b border-white/60 dark:border-white/10 text-slate-500 dark:text-slate-400">
                    <tr>
                      <th className="px-4 py-3 font-bold uppercase tracking-widest text-[10px]">Word / Phrase</th>
                      <th className="px-4 py-3 font-bold uppercase tracking-widest text-[10px]">Context meaning</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-white/5">
                    <VocabRow 
                      word="at ease"
                      meaning="relaxed and comfortable"
                      context="Which is why I think many people struggle with small talk..."
                    />
                    <VocabRow 
                      word="decorative plant"
                      meaning="a very polite decorative plant"
                      context="Do you think people are more afraid of making grammar mistakes..."
                    />
                     <VocabRow 
                      word="make"
                      meaning="to produce or cause something"
                      context="No, the goal is to make the moment feel easier..."
                    />
                  </tbody>
                </table>
              </div>
            </section>

          </div>

          {/* Right Column: AI Insights */}
          <div className="md:col-span-1">
            <section className="bg-indigo-600 rounded-3xl p-6 text-white shadow-xl relative overflow-hidden">
              <div className="absolute -right-4 -top-4 w-24 h-24 bg-white/10 rounded-full"></div>
              <div className="flex items-center gap-2 mb-4 relative z-10">
                <Sparkles size={20} className="text-white" />
                <h2 className="font-semibold text-white tracking-tight">AI Insights</h2>
              </div>
              
              <div className="flex flex-col gap-4 relative z-10">
                <div className="bg-white/10 rounded-2xl p-4 shadow-sm border border-white/20 text-sm">
                  <h4 className="font-bold text-white mb-1">Focus Area: Past Tense</h4>
                  <p className="text-indigo-100 leading-relaxed mb-3 text-sm">
                    You misheard words ending in <code className="bg-indigo-900/50 px-1 rounded text-white text-[10px]">-ed</code> in 3 recent sentences. Try a dedicated linking verb exercise to improve.
                  </p>
                  <button className="w-full py-2 bg-white text-indigo-600 rounded-xl text-sm font-black shadow-lg shadow-indigo-900/20 active:scale-95 transition-transform">
                    View Suggested Lesson
                  </button>
                </div>
                
                <div className="bg-white/10 rounded-2xl p-4 shadow-sm border border-white/20 text-sm hidden lg:block">
                   <h4 className="font-bold text-white mb-1 uppercase tracking-tighter">Pronunciation Pattern</h4>
                  <p className="text-indigo-100 leading-relaxed text-sm">
                    Native speakers often drop the 't' in "not trying" causing it to sound like <span className="italic text-white underline decoration-white/30 decoration-offset-2">nah-trying</span>.
                  </p>
                </div>
              </div>
            </section>
          </div>

        </div>
      </main>
    </div>
  );
}

function MetricCard({ title, value, icon, trend, positive }: { title: string, value: string, icon: React.ReactNode, trend?: string, positive?: boolean }) {
  return (
    <div className="bg-white/50 dark:bg-slate-800/40 backdrop-blur-md p-5 rounded-3xl border border-white/60 dark:border-white/10 shadow-xl flex flex-col hover:-translate-y-1 transition-all">
      <div className="flex justify-between items-start mb-2">
        <div className="text-slate-500 dark:text-slate-400">{icon}</div>
        {trend && (
           <div className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${positive ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400' : 'bg-slate-100 dark:bg-slate-700/50 text-slate-600 dark:text-slate-400'}`}>
            {trend}
          </div>
        )}
      </div>
      <div className="mt-auto">
        <div className="text-2xl font-bold text-slate-900 dark:text-white tracking-tight leading-none mb-1">{value}</div>
        <div className="text-[10px] text-slate-500 dark:text-slate-400 font-bold uppercase tracking-widest leading-none">{title}</div>
      </div>
    </div>
  );
}

function VocabRow({ word, meaning, context }: { word: string, meaning: string, context: string }) {
  return (
    <tr className="hover:bg-white/40 dark:hover:bg-white/5 transition-colors group cursor-pointer">
      <td className="px-4 py-3 align-top w-1/3">
        <div className="font-bold text-slate-900 dark:text-white">{word}</div>
      </td>
      <td className="px-4 py-3 align-top">
        <div className="text-slate-700 dark:text-slate-300 mb-1 font-medium italic">{meaning}</div>
        <div className="text-[11px] text-slate-500 dark:text-slate-500 line-clamp-1 italic group-hover:text-slate-700 dark:group-hover:text-slate-300 transition-colors">"{context}"</div>
      </td>
    </tr>
  );
}
