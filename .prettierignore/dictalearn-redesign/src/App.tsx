/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import Landing from './components/Landing';
import Dashboard from './components/Dashboard';
import Workspace from './components/Workspace';
import Vocabulary from './components/Vocabulary';
import History from './components/History';
import Leaderboard from './components/Leaderboard';
import { AnimatePresence, motion } from 'motion/react';
import { Sun, Moon } from 'lucide-react';

export default function App() {
  const [currentView, setCurrentView] = useState<'landing' | 'dashboard' | 'workspace' | 'vocabulary' | 'history' | 'leaderboard'>('landing');
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Sync theme with body class
  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  const renderView = () => {
    switch (currentView) {
      case 'landing':
        return <Landing onNavigate={setCurrentView} />;
      case 'dashboard':
        return <Dashboard onNavigate={setCurrentView} />;
      case 'workspace':
        return <Workspace onNavigate={setCurrentView} />;
      case 'vocabulary':
        return <Vocabulary onNavigate={setCurrentView} />;
      case 'history':
        return <History onNavigate={setCurrentView} />;
      case 'leaderboard':
        return <Leaderboard onNavigate={setCurrentView} />;
      default:
        return <Landing onNavigate={setCurrentView} />;
    }
  };

  return (
    <div className={`antialiased text-slate-900 dark:text-white bg-[#f4f7ff] dark:bg-slate-950 min-h-screen w-full overflow-hidden flex flex-col font-sans relative`}>
      {/* Background Mesh Gradients */}
      <div className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] rounded-full bg-purple-200 dark:bg-purple-900/30 blur-[120px] opacity-60 pointer-events-none z-0"></div>
      <div className="absolute bottom-[10%] right-[0%] w-[40%] h-[40%] rounded-full bg-blue-200 dark:bg-indigo-900/40 blur-[120px] opacity-60 pointer-events-none z-0"></div>

      {/* Floating Theme Toggle (Global) */}
      <div className="fixed bottom-6 right-6 z-50">
        <button 
          onClick={() => setIsDarkMode(!isDarkMode)}
          className="w-12 h-12 rounded-2xl bg-white/40 dark:bg-slate-800/40 backdrop-blur-xl border border-white/60 dark:border-white/10 shadow-xl flex items-center justify-center text-slate-600 dark:text-slate-300 hover:scale-110 active:scale-95 transition-all cursor-pointer"
        >
          {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
        </button>
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={currentView}
          initial={{ opacity: 0, filter: 'blur(4px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, filter: 'blur(4px)' }}
          transition={{ duration: 0.3 }}
          className="flex-1 flex flex-col z-10 relative overflow-y-auto w-full h-full"
        >
          {renderView()}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
