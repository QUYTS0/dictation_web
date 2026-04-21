/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import Landing from './components/Landing';
import Dashboard from './components/Dashboard';
import Workspace from './components/Workspace';
import Vocabulary from './components/Vocabulary';
import History from './components/History';
import { AnimatePresence, motion } from 'motion/react';

export default function App() {
  const [currentView, setCurrentView] = useState<'landing' | 'dashboard' | 'workspace' | 'vocabulary' | 'history'>('landing');

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
      default:
        return <Landing onNavigate={setCurrentView} />;
    }
  };

  return (
    <div className="antialiased text-slate-900 bg-[#f4f7ff] min-h-screen w-full overflow-hidden flex flex-col font-sans relative">
      {/* Background Mesh Gradients */}
      <div className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] rounded-full bg-purple-200 blur-[120px] opacity-60 pointer-events-none z-0"></div>
      <div className="absolute bottom-[10%] right-[0%] w-[40%] h-[40%] rounded-full bg-blue-200 blur-[120px] opacity-60 pointer-events-none z-0"></div>

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
