import React from 'react';
import { Headphones, Trophy, Medal, Crown, TrendingUp, ArrowUp, ChevronRight } from 'lucide-react';
import { motion } from 'motion/react';

export default function Leaderboard({ onNavigate }: { onNavigate: (view: string) => void }) {
  const leaders = [
    { rank: 1, name: 'Taylor Swift', accuracy: 98.4, xp: 12450, avatar: 'Taylor', isUser: true },
    { rank: 2, name: 'Alex Johnson', accuracy: 97.8, xp: 11200, avatar: 'Alex' },
    { rank: 3, name: 'Sam Rivera', accuracy: 96.5, xp: 9800, avatar: 'Sam' },
    { rank: 4, name: 'Jordan Lee', accuracy: 95.2, xp: 8500, avatar: 'Jordan' },
    { rank: 5, name: 'Casey Wright', accuracy: 94.8, xp: 7200, avatar: 'Casey' },
    { rank: 6, name: 'Morgan Bell', accuracy: 93.1, xp: 6800, avatar: 'Morgan' },
  ];

  return (
    <div className="flex-1 flex flex-col font-sans w-full relative z-10 h-full">
      {/* Top Navbar */}
      <header className="px-6 py-4 flex items-center justify-between border-b border-white/40 dark:border-white/10 bg-white/30 dark:bg-slate-900/40 backdrop-blur-md sticky top-0 z-20 w-full shrink-0">
        <div 
          onClick={() => onNavigate('landing')}
          className="flex items-center gap-2 cursor-pointer"
        >
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white shadow-lg shadow-indigo-200">
            <Headphones size={18} />
          </div>
          <span className="font-bold text-slate-900 dark:text-white tracking-tight text-lg">Dicta<span className="text-indigo-500">Learn</span></span>
        </div>
        <div className="flex items-center gap-6">
          <nav className="hidden md:flex gap-6">
            <button onClick={() => onNavigate('dashboard')} className="text-sm font-medium text-slate-500 dark:text-slate-400 hover:text-indigo-600 transition-colors">Dashboard</button>
            <button onClick={() => onNavigate('vocabulary')} className="text-sm font-medium text-slate-500 dark:text-slate-400 hover:text-indigo-600 transition-colors">Vocabulary</button>
            <button onClick={() => onNavigate('history')} className="text-sm font-medium text-slate-500 dark:text-slate-400 hover:text-indigo-600 transition-colors">History</button>
            <button onClick={() => onNavigate('leaderboard')} className="text-sm font-bold text-indigo-600 transition-colors">Leaderboard</button>
          </nav>
          <div className="w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-900/50 flex items-center justify-center text-indigo-700 dark:text-indigo-300 font-bold text-sm border-2 border-white dark:border-slate-800 shadow-sm overflow-hidden">
            T
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-4xl mx-auto px-4 py-8 flex flex-col gap-8 overflow-y-auto">
        
        {/* Header Section */}
        <section className="text-center mb-4">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="inline-flex items-center justify-center p-3 bg-indigo-600 rounded-2xl shadow-xl shadow-indigo-500/20 mb-6"
          >
            <Crown size={32} className="text-white" />
          </motion.div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white tracking-tight mb-2">Global League</h1>
          <p className="text-slate-500 dark:text-slate-400 text-sm">Top listeners from around the world this week.</p>
        </section>

        {/* Top 3 Podium Cards */}
        <section className="grid grid-cols-3 gap-4 items-end mb-4">
          <PodiumCard rank={2} name="Alex J." xp="11,200" avatar="Alex" />
          <PodiumCard rank={1} name="Taylor S." xp="12,450" avatar="Taylor" isFirst />
          <PodiumCard rank={3} name="Sam R." xp="9,800" avatar="Sam" />
        </section>

        {/* Full List */}
        <section className="bg-white/40 dark:bg-slate-800/40 backdrop-blur-xl border border-white/60 dark:border-white/10 rounded-3xl shadow-xl overflow-hidden mb-12">
          <div className="p-4 border-b border-white/40 dark:border-white/10 bg-white/20 dark:bg-slate-900/20 flex justify-between text-[10px] uppercase font-black text-slate-500 tracking-widest">
            <span>Rank & User</span>
            <div className="flex gap-12 mr-8">
              <span>Accuracy</span>
              <span>Total XP</span>
            </div>
          </div>
          <div className="divide-y divide-slate-200/50 dark:divide-white/5">
            {leaders.map((user, idx) => (
              <motion.div 
                initial={{ x: -20, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                transition={{ delay: idx * 0.1 }}
                key={idx}
                className={`flex items-center justify-between p-4 px-6 hover:bg-white/60 dark:hover:bg-white/5 transition-colors ${user.isUser ? 'bg-indigo-50/50 dark:bg-indigo-500/10' : ''}`}
              >
                <div className="flex items-center gap-4">
                  <span className={`w-6 text-sm font-black ${idx < 3 ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400'}`}>{user.rank}</span>
                  <div className="w-10 h-10 rounded-full border-2 border-white dark:border-slate-700 shadow-sm overflow-hidden bg-indigo-50">
                     <img src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${user.avatar}`} alt="avatar" />
                  </div>
                  <div className="flex flex-col">
                    <span className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                        {user.name}
                        {user.isUser && <span className="text-[10px] bg-indigo-600 text-white px-1.5 py-0.5 rounded uppercase tracking-tighter">You</span>}
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">Level 42</span>
                  </div>
                </div>
                
                <div className="flex items-center gap-8 text-sm">
                  <div className="w-20 text-right font-bold text-emerald-600 dark:text-emerald-400">{user.accuracy}%</div>
                  <div className="w-24 text-right font-black text-slate-800 dark:text-white flex items-center justify-end gap-1">
                    {user.xp.toLocaleString()}
                    <TrendingUp size={14} className="text-indigo-500" />
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </section>

      </main>
    </div>
  );
}

function PodiumCard({ rank, name, xp, avatar, isFirst }: { rank: number, name: string, xp: string, avatar: string, isFirst?: boolean }) {
  return (
    <div className={`flex flex-col items-center gap-3 p-4 rounded-3xl border shadow-lg transition-all ${isFirst ? 'bg-indigo-600 border-indigo-400 text-white h-56 scale-110 relative z-10' : 'bg-white/40 dark:bg-slate-800/40 border-white/60 dark:border-white/10 h-44'}`}>
      <div className={`relative ${isFirst ? 'w-20 h-20' : 'w-14 h-14'} rounded-full border-4 border-white shadow-xl overflow-hidden bg-indigo-50 shrink-0`}>
         <img src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${avatar}`} alt="avatar" />
      </div>
      <div className="text-center">
        <p className={`font-bold ${isFirst ? 'text-lg' : 'text-sm text-slate-900 dark:text-white'}`}>{name}</p>
        <p className={`text-xs ${isFirst ? 'text-indigo-100' : 'text-slate-500 font-medium'}`}>{xp} XP</p>
      </div>
      <div className={`mt-auto px-4 py-1 rounded-full text-xs font-black uppercase tracking-widest ${isFirst ? 'bg-white text-indigo-600' : 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300'}`}>
        #{rank}
      </div>
    </div>
  );
}
