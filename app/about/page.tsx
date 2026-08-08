import React from "react";
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About WordRush — Fast Online Word Puzzle Game",
  description: "Learn about WordRush, our mission to build fast, free, browser-based word games for solo players and friends worldwide.",
};

export default function AboutPage() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto space-y-12">
        <header className="text-center space-y-4">
          <h1 className="text-4xl font-extrabold tracking-tight text-white sm:text-5xl">
            About WordRush
          </h1>
          <p className="text-xl text-slate-400 max-w-2xl mx-auto">
            Fast, intuitive, and competitive word games built for quick browser play.
          </p>
        </header>

        <section className="space-y-6 text-slate-300 leading-relaxed bg-slate-900 p-8 rounded-2xl border border-slate-800">
          <h2 className="text-2xl font-bold text-emerald-400">
            What is WordRush?
          </h2>
          <p>
            WordRush is a modern online word game designed for players who love fast thinking, rich dictionaries, and friendly competition. Whether you have 2 minutes for a quick solo challenge or an hour to play with friends in private multiplayer rooms, WordRush offers instant action without downloads or paywalls.
          </p>
          <p>
            Unlike traditional slow-paced word board games, WordRush emphasizes real-time decision-making across dynamic letter grids, featuring multiple distinct game modes like Classic, Word Chain, and Room Heist.
          </p>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-slate-900 p-6 rounded-xl border border-slate-800">
            <h3 className="text-lg font-semibold text-white mb-2">⚡ Instant Browser Play</h3>
            <p className="text-slate-400 text-sm">
              No app stores, no hefty downloads, and no forced logins. Jump straight into a game on phone, tablet, or desktop.
            </p>
          </div>
          <div className="bg-slate-900 p-6 rounded-xl border border-slate-800">
            <h3 className="text-lg font-semibold text-white mb-2">👥 Real-Time Multiplayer</h3>
            <p className="text-slate-400 text-sm">
              Create instant custom rooms, share invite links, and race head-to-head against friends with live scoreboard updates.
            </p>
          </div>
        </section>

        <footer className="pt-8 border-t border-slate-800 text-center space-y-6">
          <div className="flex flex-wrap justify-center gap-4 text-sm font-medium text-emerald-400">
            <Link href="/how-to-play/classic" className="hover:underline">
              How to Play Guides
            </Link>
            <span>•</span>
            <Link href="/faq" className="hover:underline">
              FAQ
            </Link>
          </div>

          <div>
            <Link
              href="/"
              className="inline-flex items-center justify-center px-8 py-3 text-base font-bold rounded-lg text-slate-950 bg-emerald-400 hover:bg-emerald-300 transition shadow-lg"
            >
              Play WordRush Now
            </Link>
          </div>
        </footer>
      </div>
    </main>
  );
}
