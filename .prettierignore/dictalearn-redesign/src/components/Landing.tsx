import React from 'react';
import { Play, Pause, Headphones, Zap, BrainCircuit, CheckCircle2, ShieldCheck, ArrowRight, Video } from 'lucide-react';
import { motion } from 'motion/react';

export default function Landing({ onNavigate }: { onNavigate: (view: string) => void }) {
  return (
    <div className="flex-1 flex flex-col font-sans w-full">
      {/* Navbar */}
      <header className="px-6 py-4 flex items-center justify-between border-b border-white/40 dark:border-white/10 bg-white/30 dark:bg-slate-900/40 backdrop-blur-md sticky top-0 z-10 w-full">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white">
            <Headphones size={18} />
          </div>
          <span className="font-semibold text-slate-900 dark:text-white tracking-tight text-lg">DictaLearn</span>
        </div>
        <div className="flex items-center gap-4">
          <button 
            onClick={() => onNavigate('dashboard')}
            className="text-sm font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
          >
            Sign In
          </button>
          <button 
            onClick={() => onNavigate('dashboard')}
            className="text-sm font-medium bg-slate-900 dark:bg-white text-white dark:text-slate-950 px-4 py-2 rounded-full hover:bg-slate-800 dark:hover:bg-slate-100 transition-colors shadow-sm"
          >
            Get Started
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-4 py-16 w-full max-w-7xl mx-auto">
        
        {/* Hero Section */}
        <section className="text-center max-w-3xl mx-auto mb-16 pt-8">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-400 text-xs font-semibold mb-6 border border-indigo-100 dark:border-indigo-500/20">
              <Zap size={14} className="text-indigo-500" />
              <span>Master English through listening</span>
            </div>
            <h1 className="text-4xl md:text-6xl font-semibold tracking-tight text-slate-900 dark:text-white mb-6 text-balance leading-tight">
              Turn any YouTube video into an <span className="text-indigo-600 dark:text-indigo-400">interactive language lesson</span>
            </h1>
            <p className="text-lg md:text-xl text-slate-600 dark:text-slate-400 mb-8 max-w-2xl mx-auto leading-relaxed">
              Paste a link, listen sentence by sentence, and type what you hear. Our AI provides instant feedback to perfect your comprehension and grammar.
            </p>
          </motion.div>

          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="bg-white/40 dark:bg-slate-800/40 backdrop-blur-xl p-3 md:p-4 rounded-3xl shadow-xl border border-white/60 dark:border-white/10 flex flex-col sm:flex-row gap-3 max-w-2xl mx-auto focus-within:ring-2 focus-within:ring-indigo-500/30 dark:focus-within:ring-indigo-500/50 transition-all"
          >
            <div className="relative flex-1 flex items-center">
              <Video className="absolute left-4 text-slate-400" size={20} />
              <input 
                type="text" 
                placeholder="Paste YouTube URL here (e.g. https://www.youtube.com/...)" 
                className="w-full bg-transparent border-none focus:ring-0 pl-12 pr-4 py-3 text-slate-900 dark:text-white placeholder:text-slate-400 outline-none text-base"
              />
            </div>
            <button 
              onClick={() => onNavigate('workspace')}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-3 rounded-xl font-medium flex items-center justify-center gap-2 transition-colors shadow-sm whitespace-nowrap"
            >
              Start Dictation <ArrowRight size={18} />
            </button>
          </motion.div>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-4">Start without signing in. Sign in later to save progress.</p>
        </section>

        {/* Features Section */}
        <section className="grid md:grid-cols-3 gap-6 w-full mt-12">
          <FeatureCard 
            icon={<Play size={24} />}
            title="Auto-pause Engine"
            description="The video automatically pauses after each sentence, giving you time to process and type without frantic clicking."
            delay={0.2}
          />
          <FeatureCard 
            icon={<BrainCircuit size={24} />}
            title="AI Grammar Insights"
            description="Get personalized explanations for your mistakes. Understand why you misheard something, not just that you did."
            delay={0.3}
          />
          <FeatureCard 
            icon={<ShieldCheck size={24} />}
            title="Relaxed Matching"
            description="Focus on meaning, not mechanics. Our system ignores minor punctuation and capitalization so you can flow."
            delay={0.4}
          />
        </section>
      </main>
    </div>
  );
}

function FeatureCard({ icon, title, description, delay }: { icon: React.ReactNode, title: string, description: string, delay: number }) {
  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay }}
      className="bg-white/40 dark:bg-slate-800/40 backdrop-blur-xl p-6 rounded-3xl border border-white/60 dark:border-white/10 shadow-xl hover:-translate-y-1 transition-all"
    >
      <div className="w-12 h-12 rounded-xl bg-white/60 dark:bg-slate-700/60 border border-white/80 dark:border-white/10 flex items-center justify-center text-indigo-600 dark:text-indigo-400 mb-4 shadow-sm">
        {icon}
      </div>
      <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-2">{title}</h3>
      <p className="text-slate-500 dark:text-slate-400 leading-relaxed text-sm">
        {description}
      </p>
    </motion.div>
  );
}
