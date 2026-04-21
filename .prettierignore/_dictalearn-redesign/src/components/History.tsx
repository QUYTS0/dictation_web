import React from 'react';
import { Headphones, History as ClockIcon, Calendar, CheckCircle2, PlayCircle, Clock, ChevronRight } from 'lucide-react';
import { motion } from 'motion/react';

export default function History({ onNavigate }: { onNavigate: (view: string) => void }) {
  const historyItems = [
    { id: 1, title: 'English Podcast For Easy English Learning', channel: 'Speak English With Class', date: 'Today, 10:45 AM', accuracy: 87, time: '14 min', progress: 51, totalSents: 88, completedSents: 45, imgSeed: 'podcast1' },
    { id: 2, title: 'Steve Jobs Stanford Commencement Speech', channel: 'Stanford', date: 'Yesterday, 3:20 PM', accuracy: 92, time: '22 min', progress: 100, totalSents: 56, completedSents: 56, imgSeed: 'speech' },
    { id: 3, title: 'Daily English Conversation Practice', channel: 'EnglishClass101', date: 'Oct 24, 2023', accuracy: 78, time: '8 min', progress: 30, totalSents: 120, completedSents: 36, imgSeed: 'conversation' },
    { id: 4, title: 'The power of vulnerability | Brené Brown', channel: 'TED', date: 'Oct 22, 2023', accuracy: 95, time: '45 min', progress: 100, totalSents: 154, completedSents: 154, imgSeed: 'ted' },
  ];

  return (
    <div className="flex-1 flex flex-col font-sans w-full relative z-10 h-full">
      {/* Top Navbar */}
      <header className="px-6 py-4 flex items-center justify-between border-b border-white/40 bg-white/30 backdrop-blur-md sticky top-0 z-20 w-full shrink-0">
        <div 
          onClick={() => onNavigate('landing')}
          className="flex items-center gap-2 cursor-pointer"
        >
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white shadow-lg shadow-indigo-200">
            <Headphones size={18} />
          </div>
          <span className="font-bold text-slate-900 tracking-tight text-lg">Dicta<span className="text-indigo-500">Learn</span></span>
        </div>
        <div className="flex items-center gap-6">
          <nav className="hidden md:flex gap-6">
            <button onClick={() => onNavigate('dashboard')} className="text-sm font-medium text-slate-500 hover:text-indigo-600 transition-colors">Dashboard</button>
            <button onClick={() => onNavigate('vocabulary')} className="text-sm font-medium text-slate-500 hover:text-indigo-600 transition-colors">Vocabulary</button>
            <button onClick={() => onNavigate('history')} className="text-sm font-bold text-indigo-600">History</button>
          </nav>
          <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-sm border-2 border-white shadow-sm overflow-hidden">
            T
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-4xl mx-auto px-4 py-8 flex flex-col gap-8 overflow-y-auto">
        
        {/* Header Section */}
        <section className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6 border-b border-white/40 pb-6">
          <div>
             <h1 className="text-3xl font-bold text-slate-900 tracking-tight mb-2">Practice History</h1>
             <p className="text-slate-500 text-sm">Track your dictation sessions and progress.</p>
          </div>
          <div className="flex gap-4 w-full md:w-auto">
             <div className="bg-white/50 backdrop-blur-md p-3 px-5 rounded-2xl border border-white/60 shadow-sm flex items-center gap-3 flex-1 md:flex-initial">
               <ClockIcon className="text-indigo-500" size={20} />
               <div>
                 <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wide">Total Time</p>
                 <p className="text-lg font-black text-slate-800 leading-none">2h 15m</p>
               </div>
             </div>
             <div className="bg-white/50 backdrop-blur-md p-3 px-5 rounded-2xl border border-white/60 shadow-sm flex items-center gap-3 flex-1 md:flex-initial">
               <PlayCircle className="text-emerald-500" size={20} />
               <div>
                 <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wide">Videos</p>
                 <p className="text-lg font-black text-slate-800 leading-none">12</p>
               </div>
             </div>
          </div>
        </section>

        {/* History List */}
        <section className="flex flex-col gap-4 pb-12">
           {historyItems.map((item, idx) => (
             <motion.div 
               initial={{ opacity: 0, y: 10 }}
               animate={{ opacity: 1, y: 0 }}
               transition={{ delay: idx * 0.1 }}
               key={item.id}
               onClick={() => onNavigate('workspace')}
               className="group relative bg-white/40 backdrop-blur-xl rounded-3xl border border-white/60 shadow-lg p-4 sm:p-5 flex flex-col sm:flex-row gap-5 hover:-translate-y-1 transition-all cursor-pointer"
             >
               {/* Thumbnail Area */}
               <div className="relative w-full sm:w-56 aspect-[16/9] rounded-2xl overflow-hidden bg-slate-800 shrink-0 shadow-md">
                 <img src={`https://picsum.photos/seed/${item.imgSeed}/400/225`} alt="Video thumbnail" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" referrerPolicy="no-referrer" />
                 {item.progress === 100 && (
                   <div className="absolute top-2 right-2 bg-emerald-500/90 text-white backdrop-blur px-2 py-1 rounded-lg text-xs font-bold shadow-sm flex items-center gap-1">
                     <CheckCircle2 size={12} /> Done
                   </div>
                 )}
                 <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                   <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur-md border border-white/30 flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                     <PlayCircle className="text-white fill-white/20" size={20} />
                   </div>
                 </div>
               </div>
               
               {/* Info Area */}
               <div className="flex-1 flex flex-col justify-between py-1">
                 <div>
                   <div className="flex justify-between items-start gap-4 mb-1">
                     <h3 className="font-bold text-lg text-slate-900 group-hover:text-indigo-600 transition-colors leading-tight">{item.title}</h3>
                     <span className="flex items-center text-indigo-600 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                       <ChevronRight size={20} />
                     </span>
                   </div>
                   <p className="text-sm font-medium text-slate-500 mb-3">{item.channel}</p>
                 </div>
                 
                 <div>
                   {/* Metrics Row */}
                   <div className="flex flex-wrap gap-4 mb-4">
                     <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 bg-white/50 px-2 py-1 rounded-lg border border-white/40">
                       <Calendar size={14} className="text-slate-400" />
                       {item.date}
                     </div>
                     <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 bg-white/50 px-2 py-1 rounded-lg border border-white/40">
                       <Clock size={14} className="text-slate-400" />
                       {item.time} practiced
                     </div>
                     <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 px-2 py-1 rounded-lg border border-emerald-100">
                       <CheckCircle2 size={14} className="text-emerald-500" />
                       {item.accuracy}% Accuracy
                     </div>
                   </div>

                   {/* Progress */}
                   <div>
                     <div className="flex justify-between text-xs font-bold text-slate-500 mb-1.5">
                       <span className="uppercase tracking-widest text-[10px]">Progress</span>
                       <span>{item.completedSents} / {item.totalSents} Sentences</span>
                     </div>
                     <div className="w-full bg-white/50 border border-white/40 rounded-full h-2 overflow-hidden shadow-inner flex">
                       <div className="bg-indigo-500 h-full rounded-full transition-all duration-1000" style={{ width: `${item.progress}%` }}></div>
                     </div>
                   </div>
                 </div>
               </div>
             </motion.div>
           ))}
        </section>

      </main>
    </div>
  );
}
