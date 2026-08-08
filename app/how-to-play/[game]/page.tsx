import React from 'react';
import Link from 'next/link';

export interface GameGuide {
  title: string;
  description: string;
  rules: string[];
  gameRoute: string;
}

const GAME_GUIDES: Record<string, GameGuide> = {
  classic: {
    title: 'How to Play Classic WordRush',
    description: 'The core WordRush experience. Build valid words on a grid before time runs out.',
    rules: ['Standard grid size', 'Classic timer mechanics', 'Minimum 3-letter words'],
    gameRoute: '/games/classic',
  },
  'word-chain': {
    title: 'How to Play Word Chain',
    description: 'Connect consecutive words sharing boundary letters in a sequence.',
    rules: ['Each word must begin with the last letter of the previous word', 'Bonus points for longer chains'],
    gameRoute: '/games/word-chain',
  },
  'room-heist': {
    title: 'How to Play Room Heist',
    description: 'Multiplayer heist mode. Solve word locks cooperatively before the alarm triggers.',
    rules: ['Multiplayer co-op required', 'Solve vault combination words together'],
    gameRoute: '/games/room-heist',
  },
};

export default function HowToPlayGamePage({ params }: { params: { game: string } }) {
  const guide = GAME_GUIDES[params.game] || {
    title: `How to Play ${params.game}`,
    description: 'Learn the rules and mechanics for this game mode.',
    rules: ['Follow standard WordRush dictionary rules.'],
    gameRoute: `/games/${params.game}`,
  };

  return (
    <main className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-4">{guide.title}</h1>
      <p className="text-lg text-gray-600 dark:text-gray-300 mb-6">{guide.description}</p>

      <div className="bg-gray-50 dark:bg-gray-800 p-6 rounded-lg mb-8">
        <h2 className="text-xl font-semibold mb-3">Rules & Mechanics</h2>
        <ul className="list-disc pl-5 space-y-2 text-gray-700 dark:text-gray-300">
          {guide.rules.map((rule, idx) => (
            <li key={idx}>{rule}</li>
          ))}
        </ul>
      </div>

      <div className="flex items-center space-x-4">
        <Link
          href={guide.gameRoute}
          className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-semibold transition"
        >
          Play Now &rarr;
        </Link>
        <Link href="/how-to-play" className="text-gray-500 hover:text-gray-700 underline text-sm">
          &larr; Back to all guides
        </Link>
      </div>
    </main>
  );
}
