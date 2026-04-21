import React, { useState } from 'react';
import { Headphones, Search, Filter, Volume2, Star, TrendingUp, BookOpen } from 'lucide-react';
import { motion } from 'motion/react';

export default function Vocabulary({ onNavigate }: { onNavigate: (view: string) => void }) {
  const [searchTerm, setSearchTerm] = useState('');

  const vocabList = [
    { word: 'at ease', meaning: 'relaxed and comfortable', context: 'Which is why I think many people struggle with small talk...', mastery: 80, isStarred: true },
    { word: 'decorative plant', meaning: 'a very polite decorative plant', context: 'Do you think people are more afraid of making grammar mistakes...', mastery: 40, isStarred: false },
    { word: 'make', meaning: 'to produce or cause something', context: 'No, the goal is to make the moment feel easier...', mastery: 100, isStarred: true },
    { word: 'impressive', meaning: 'evoking admiration through size, quality, or skill', context: 'Not fighting the moment, not trying to be impressive.', mastery: 20, isStarred: false },
    { word: 'struggle', meaning: 'make forceful or violent efforts to get free', context: 'Many people struggle with small talk for the wrong reason.', mastery: 60, isStarred: false },
    { word: 'awkward', meaning: 'causing or feeling embarrassment or inconvenience', context: 'More afraid of making grammar mistakes or of feeling awkward?', mastery: 90, isStarred: true },
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
            <button onClick={() => onNavigate('vocabulary')} className="text-sm font-bold text-indigo-600">Vocabulary</button>
            <button onClick={() => onNavigate('history')} className="text-sm font-medium text-slate-500 hover:text-indigo-600 transition-colors">History</button>
          </nav>
          <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-sm border-2 border-white shadow-sm overflow-hidden">
            T
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 py-8 flex flex-col gap-8 overflow-y-auto">
        
        {/* Header Section */}
        <section className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 tracking-tight mb-2">Vocabulary Bank</h1>
            <p className="text-slate-500 text-sm">Review and master the words you've learned.</p>
          </div>
          <div className="flex gap-4 w-full md:w-auto">
            <div className="bg-white/50 backdrop-blur-md p-3 px-5 rounded-2xl border border-white/60 shadow-sm flex items-center gap-3 flex-1 md:flex-initial">
              <BookOpen className="text-indigo-500" size={20} />
              <div>
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wide">Total Words</p>
                <p className="text-lg font-black text-slate-800 leading-none">124</p>
              </div>
            </div>
            <div className="bg-white/50 backdrop-blur-md p-3 px-5 rounded-2xl border border-white/60 shadow-sm flex items-center gap-3 flex-1 md:flex-initial">
              <Star className="text-amber-500 fill-amber-500" size={20} />
              <div>
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wide">Mastered</p>
                <p className="text-lg font-black text-slate-800 leading-none">42</p>
              </div>
            </div>
          </div>
        </section>

        {/* Search & Filter */}
        <section className="flex gap-3">
          <div className="relative flex-1 bg-white/40 backdrop-blur-xl border border-white/60 rounded-2xl shadow-sm overflow-hidden focus-within:ring-2 focus-within:ring-indigo-500/30 transition-all">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input 
              type="text" 
              placeholder="Search words, meanings, or sentences..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-transparent outline-none py-3 pl-11 pr-4 text-slate-800 placeholder:text-slate-400 font-medium"
            />
          </div>
          <button className="bg-white/60 backdrop-blur-xl border border-white/80 rounded-2xl px-4 flex items-center gap-2 shadow-sm text-slate-600 hover:text-indigo-600 transition-colors font-semibold shadow-md active:translate-y-px">
            <Filter size={18} />
            <span className="hidden sm:inline">Filter</span>
          </button>
        </section>

        {/* Vocabulary Grid */}
        <section className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 pb-12">
          {vocabList.filter(item => item.word.toLowerCase().includes(searchTerm.toLowerCase()) || item.meaning.toLowerCase().includes(searchTerm.toLowerCase())).map((item, idx) => (
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.05 }}
              key={idx}
              className="bg-white/40 backdrop-blur-xl p-6 rounded-3xl border border-white/60 shadow-xl hover:-translate-y-1 transition-all group flex flex-col h-full"
            >
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-xl font-bold text-indigo-900 group-hover:text-indigo-600 transition-colors">{item.word}</h3>
                  <div className="flex items-center gap-2 mt-1">
                    <button className="text-slate-400 hover:text-indigo-500 transition-colors bg-white/50 p-1 rounded-md border border-white/40 shadow-sm">
                      <Volume2 size={14} />
                    </button>
                    <span className="text-xs text-emerald-600 font-bold bg-emerald-100/50 px-2 py-0.5 rounded-md border border-emerald-200/50">Noun</span>
                  </div>
                </div>
                <button className={`p-2 rounded-xl transition-colors ${item.isStarred ? 'bg-amber-100/50 border border-amber-200/50' : 'bg-white/50 border border-white/60 hover:bg-white/80'}`}>
                  <Star size={18} className={item.isStarred ? "text-amber-500 fill-amber-500" : "text-slate-400"} />
                </button>
              </div>
              
              <div className="mb-4 flex-1">
                <p className="text-slate-700 font-medium leading-relaxed">{item.meaning}</p>
                <div className="mt-3 p-3 bg-white/30 rounded-xl border border-white/40 shadow-inner">
                  <p className="text-sm text-slate-500 italic leading-relaxed line-clamp-3">"{item.context}"</p>
                </div>
              </div>

              {/* Mastery Indicator */}
              <div className="mt-auto border-t border-white/40 pt-4">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Mastery</span>
                  <span className="text-[10px] font-bold text-indigo-600">{item.mastery}%</span>
                </div>
                <div className="w-full h-1.5 bg-slate-200/50 rounded-full overflow-hidden shadow-inner flex">
                   <div 
                     className="h-full bg-gradient-to-r from-indigo-400 to-indigo-600 rounded-full relative" 
                     style={{ width: `${item.mastery}%` }}
                   ></div>
                </div>
              </div>
            </motion.div>
          ))}
        </section>

      </main>
    </div>
  );
}
