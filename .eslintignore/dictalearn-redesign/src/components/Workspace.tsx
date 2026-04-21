import React, { useState } from 'react';
import { ArrowLeft, Settings, SkipBack, Play, Pause, SkipForward, Repeat, HelpCircle, Check, X, FileText, Bookmark, CheckCircle2, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

export default function Workspace({ onNavigate }: { onNavigate: (view: string) => void }) {
  const [activeTab, setActiveTab] = useState<'script' | 'saved'>('script');
  const [inputValue, setInputValue] = useState('');
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [isZenMode, setIsZenMode] = useState(false);

  // Dummy action to simulate checking
  const handleCheck = () => {
    if (!inputValue.trim()) return;
    setChecking(true);
    setTimeout(() => {
      setChecking(false);
      // rough check for demo
      if (inputValue.toLowerCase().includes('not fighting')) {
        setStatus('success');
      } else {
        setStatus('error');
      }
    }, 500);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleCheck();
  };

  return (
    <div className="flex-1 flex flex-col font-sans w-full h-full overflow-hidden relative">
      {/* Zen Mode Background Overlay */}
      <AnimatePresence>
        {isZenMode && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-slate-950/90 backdrop-blur-2xl z-40 transition-all"
          />
        )}
      </AnimatePresence>

      {/* Header */}
      <AnimatePresence>
        {!isZenMode && (
          <motion.header 
            initial={{ y: -64, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -64, opacity: 0 }}
            className="px-4 py-3 flex items-center justify-between border-b border-white/40 dark:border-white/10 bg-white/30 dark:bg-slate-900/40 backdrop-blur-md sticky top-0 z-10 shrink-0"
          >
            <div className="flex items-center gap-4">
              <button 
                onClick={() => onNavigate('dashboard')}
                className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/40 dark:hover:bg-white/10 text-slate-500 dark:text-slate-400 transition-colors"
              >
                <ArrowLeft size={18} />
              </button>
              <div className="flex flex-col">
                <h1 className="font-semibold text-slate-900 dark:text-white text-sm leading-tight">English Podcast For Easy English...</h1>
                <span className="text-xs text-slate-500 dark:text-slate-400">Sentence 88 of 348</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button 
                onClick={() => setIsZenMode(true)}
                className="text-xs font-bold px-3 py-1.5 rounded-lg border border-white/60 dark:border-white/10 bg-white/40 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:bg-white/80 dark:hover:bg-white/10 transition-colors flex items-center gap-2"
              >
                <Sparkles size={14} className="text-indigo-500" />
                Zen Mode
              </button>
              <button className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/40 dark:hover:bg-white/10 text-slate-500 dark:text-slate-400 transition-colors">
                <Settings size={18} />
              </button>
            </div>
          </motion.header>
        )}
      </AnimatePresence>

      {/* Main Workspace */}
      <main className={`flex-1 flex gap-6 p-6 overflow-hidden z-10 transition-all ${isZenMode ? 'justify-center items-center' : ''}`}>
        
        {/* Left Column (Video & Interaction) */}
        <div className={`flex flex-col gap-6 overflow-y-auto pb-12 pr-2 transition-all duration-500 ${isZenMode ? 'flex-1 max-w-4xl z-50' : 'flex-[0.65]'}`}>
            
            {/* Video Placeholder */}
            <div className={`relative w-full aspect-video bg-black rounded-3xl overflow-hidden shadow-2xl border border-white/20 shrink-0 transition-transform ${isZenMode ? 'scale-105' : ''}`}>
              <img src="https://picsum.photos/seed/podcast/800/450" alt="Video frame" className="w-full h-full object-cover opacity-70" referrerPolicy="no-referrer" />
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-16 h-16 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center border border-white/30">
                  <Play className="text-white fill-white ml-1" size={24} />
                </div>
              </div>
              {/* Fake Subtitles */}
              <div className="absolute bottom-8 left-0 right-0 text-center px-8">
                <span className="bg-black/95 text-white font-mono text-lg px-6 py-3 rounded-2xl backdrop-blur-md shadow-2xl border border-white/10">
                  <span className="text-white/40">not fighting the moment, </span>
                  <span className="font-semibold text-indigo-400">not trying to be</span>
                </span>
              </div>
            </div>

            {/* Interaction Details Wrapper */}
            <div className={`flex-1 bg-white/40 dark:bg-slate-800/40 backdrop-blur-xl border border-white/60 dark:border-white/10 rounded-3xl p-6 sm:p-8 flex flex-col shadow-xl transition-all ${isZenMode ? 'bg-slate-900/40 border-white/5' : ''}`}>
              {/* Controls */}
              <div className="flex items-center justify-between px-2 mb-2">
                <div className="flex items-center gap-3">
                  <ControlButton icon={<SkipBack size={18} />} shortcut="Shift + &larr;" label="Prev" />
                  <ControlButton icon={<Repeat size={18} />} shortcut="Shift + Space" label="Replay" primary />
                  <ControlButton icon={<SkipForward size={18} />} shortcut="Shift + &rarr;" label="Next" />
                </div>
                <div className="flex items-center gap-2 text-sm font-medium text-slate-500 dark:text-slate-400">
                  <CheckCircle2 size={16} className="text-emerald-500" />
                  <span>Accuracy: 51%</span>
                </div>
              </div>

              {/* Input Area */}
              <div className="relative mt-4">
                <div className={`relative rounded-2xl overflow-hidden border-2 transition-all ${
                  status === 'success' ? 'border-emerald-500 bg-emerald-50/30' :
                  status === 'error' ? 'border-red-500 bg-red-50/30' :
                  `border-slate-200 dark:border-white/10 bg-white dark:bg-slate-900 focus-within:border-indigo-500 focus-within:ring-4 focus-within:ring-indigo-500/10 ${isZenMode ? 'shadow-2xl' : ''}`
                }`}>
                  <input
                    type="text"
                    value={inputValue}
                    onChange={(e) => {
                      setInputValue(e.target.value);
                      setStatus('idle');
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder="Type what you hear..."
                    className="w-full bg-transparent p-6 pr-24 text-xl font-medium text-slate-900 dark:text-white placeholder:text-slate-400 outline-none"
                    autoFocus
                  />
                  
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center">
                    <AnimatePresence mode="wait">
                      {checking ? (
                        <motion.div
                          key="loading"
                          initial={{ opacity: 0, scale: 0.8 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.8 }}
                          className="w-8 h-8 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin"
                        />
                      ) : status === 'success' ? (
                        <motion.div
                          key="success"
                          initial={{ opacity: 0, scale: 0.8 }}
                          animate={{ opacity: 1, scale: 1 }}
                          className="bg-emerald-500 text-white p-2 rounded-xl flex items-center shadow-lg"
                        >
                           <Check size={20} strokeWidth={3} />
                        </motion.div>
                      ) : status === 'error' ? (
                        <motion.button
                          key="error"
                          onClick={() => setStatus('idle')}
                          initial={{ opacity: 0, scale: 0.8 }}
                          animate={{ opacity: 1, scale: 1 }}
                          className="bg-red-500 text-white px-4 py-2 rounded-xl font-bold text-sm shadow-lg active:scale-95 transition-all"
                        >
                          Try Again
                        </motion.button>
                      ) : (
                        <motion.button
                          key="idle"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          onClick={handleCheck}
                          disabled={!inputValue.trim()}
                          className="bg-indigo-600 text-white px-6 py-2.5 rounded-xl font-bold text-sm hover:bg-indigo-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-indigo-500/20 active:scale-95"
                        >
                          Check &crarr;
                        </motion.button>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              </div>

              {/* Answer Comparison & Hints */}
              <AnimatePresence>
                {status === 'error' && (
                  <motion.div
                    initial={{ height: 0, opacity: 0, scale: 0.95 }}
                    animate={{ height: 'auto', opacity: 1, scale: 1 }}
                    exit={{ height: 0, opacity: 0, scale: 0.95 }}
                    className="overflow-hidden"
                  >
                    <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-5 mt-4">
                      <h4 className="text-[10px] font-black text-red-500 uppercase tracking-[0.2em] mb-3">Correction Needed</h4>
                      <div className="font-mono text-sm leading-relaxed p-4 bg-white/20 dark:bg-black/20 rounded-xl border border-red-500/20 shadow-inner">
                        <span className="text-red-500 line-through mr-3 opacity-60 decoration-2">{inputValue}</span>
                        <span className="text-slate-900 dark:text-white bg-red-500/20 px-2 py-0.5 rounded font-bold underline decoration-red-500/50 decoration-offset-4">not fighting the moment</span>
                        <span className="text-slate-400 dark:text-slate-500 ml-3 font-bold">... ... ...</span>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Need a hint button */}
              <div className="flex justify-center mt-6">
                 <button className="flex items-center gap-2 text-sm font-bold text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 bg-white/60 dark:bg-white/5 hover:bg-white/90 px-6 py-3 rounded-2xl transition-all border border-white/80 dark:border-white/10 shadow-sm active:scale-95">
                    <HelpCircle size={18} /> Need a hint?
                 </button>
              </div>

              {/* Exit Zen Button (Only in Zen Mode) */}
              <AnimatePresence>
                {isZenMode && (
                  <motion.div 
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 20 }}
                    className="mt-8 flex justify-center"
                  >
                    <button 
                      onClick={() => setIsZenMode(false)}
                      className="group flex flex-col items-center gap-2"
                    >
                      <div className="w-12 h-12 rounded-full bg-white/10 border border-white/20 backdrop-blur-md flex items-center justify-center text-white/50 group-hover:text-white group-hover:bg-white/20 transition-all group-hover:scale-110">
                         <X size={24} />
                      </div>
                      <span className="text-[10px] uppercase font-black tracking-widest text-white/30 group-hover:text-white/60 transition-colors">Exit Zen Mode</span>
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>

            </div>
        </div>

        {/* Right Column (Lesson Panel Sidebar) */}
        {!isZenMode && (
          <motion.div 
            initial={{ x: 100, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 100, opacity: 0 }}
            className="flex-[0.35] bg-white/60 dark:bg-slate-800/60 backdrop-blur-xl border border-white/80 dark:border-white/10 rounded-3xl flex flex-col overflow-hidden shadow-lg shrink-0"
          >
            <div className="p-4 border-b border-white/40 dark:border-white/10 bg-white/30 dark:bg-slate-900/40 backdrop-blur-md">
              <h2 className="font-semibold text-slate-900 dark:text-white mb-4">Lesson panel</h2>
              {/* Custom Tab Switcher */}
              <div className="flex bg-white/40 dark:bg-slate-900/40 border border-white/60 dark:border-white/10 p-1 rounded-xl shadow-inner text-slate-900 dark:text-white">
                <button 
                  onClick={() => setActiveTab('script')}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-bold rounded-lg transition-all ${activeTab === 'script' ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-sm border border-white/60 dark:border-white/10' : 'text-slate-500 dark:text-slate-400 hover:text-indigo-600'}`}
                >
                  <FileText size={16} /> Script
                </button>
                <button 
                   onClick={() => setActiveTab('saved')}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-bold rounded-lg transition-all ${activeTab === 'saved' ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-sm border border-white/60 dark:border-white/10' : 'text-slate-500 dark:text-slate-400 hover:text-indigo-600'}`}
                >
                  <Bookmark size={16} /> Saved
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
              {activeTab === 'script' && (
                <div className="flex flex-col gap-4 relative text-sm">
                  <div className="p-4 bg-amber-50 dark:bg-amber-500/5 text-amber-800 dark:text-amber-400 text-[11px] rounded-xl border border-amber-200/60 dark:border-amber-500/20 mb-2 leading-relaxed font-medium">
                    Viewing the script may reveal answers. Be careful!
                  </div>
                  
                  {/* Script Items */}
                  <ScriptItem number={87} text="at ease means relaxed and comfortable" isPrevious />
                  <ScriptItem number={88} text="Not fighting the moment, not trying to be impressive." isActive />
                  <ScriptItem number={89} text="Just being there." />
                  <ScriptItem number={90} text=">> I love that actually because small talk gets easier the moment you stop treating it like a test. >> Yes." />
                </div>
              )}
              
              {activeTab === 'saved' && (
                <div className="flex flex-col items-center justify-center h-full text-center px-4">
                  <Bookmark size={32} className="text-slate-300 dark:text-slate-600 mb-3" />
                  <p className="text-slate-500 dark:text-slate-400 text-xs font-medium">Select text in the script to save words or phrases here for later review.</p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </main>
    </div>
  );
}

function ControlButton({ icon, shortcut, label, primary }: { icon: React.ReactNode, shortcut: string, label: string, primary?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-1 group">
      <button className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all shadow-sm border border-white/60 dark:border-white/10 ${primary ? 'bg-indigo-600 text-white hover:bg-indigo-700 hover:shadow-md hover:-translate-y-0.5' : 'bg-white/60 dark:bg-white/5 text-slate-700 dark:text-slate-300 hover:bg-white dark:hover:bg-white/10 hover:border-slate-300 dark:hover:border-slate-600'}`}>
        {icon}
      </button>
      <div className="opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center">
         <span className="text-[10px] font-semibold text-slate-400 dark:text-slate-500">{label}</span>
      </div>
    </div>
  );
}

function ScriptItem({ number, text, isActive, isPrevious }: { number: number, text: string, isActive?: boolean, isPrevious?: boolean }) {
  return (
    <div className={`p-4 rounded-xl border transition-colors shadow-sm ${
      isActive ? 'bg-white/80 dark:bg-slate-700/60 border-indigo-200 dark:border-indigo-500/40 ring-2 ring-indigo-500/20' : 
      isPrevious ? 'bg-white/40 dark:bg-white/5 border-white/60 dark:border-white/10 opacity-80 hover:opacity-100' : 'bg-white/40 dark:bg-white/5 border-white/60 dark:border-white/10 opacity-80 hover:opacity-100'
    }`}>
      <div className={`text-xs font-bold mb-1 flex items-center justify-between ${isActive ? 'text-indigo-600 dark:text-indigo-400' : isPrevious ? 'text-emerald-600' : 'text-slate-500'}`}>
        <span className="uppercase tracking-widest text-[9px]">Sentence #{number}</span>
        {isActive && <div className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse"></div>}
      </div>
      <p className={`text-sm leading-relaxed ${isActive ? 'text-slate-900 dark:text-white font-medium' : 'text-slate-600 dark:text-slate-400'}`}>
        {text}
      </p>
    </div>
  );
}
