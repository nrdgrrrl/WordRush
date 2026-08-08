import React from "react";
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Frequently Asked Questions — WordRush",
  description: "Get quick answers to common questions about playing WordRush online, multiplayer room creation, dictionary rules, scoring, and game modes.",
};

const FAQS = [
  {
    q: "What is WordRush?",
    a: "WordRush is a fast-paced multiplayer and solo word game where players race against time to form valid words from a grid of letter tiles.",
  },
  {
    q: "Is WordRush free to play?",
    a: "Yes! WordRush is 100% free to play directly in your web browser with no downloads required.",
  },
  {
    q: "Do I need an account to play?",
    a: "No account is required to start a quick match or create a room with friends. Account creation is optional for saving stats and achievement progress.",
  },
  {
    q: "Can I play with friends in private rooms?",
    a: "Yes! You can create custom multiplayer rooms and share the invite link or code with your friends instantly.",
  },
  {
    q: "What counts as a valid word?",
    a: "Words must be present in the official WordRush standard dictionary. Proper nouns, abbreviations, and hyphenated words are generally excluded.",
  },
  {
    q: "What are the different game modes available?",
    a: "WordRush features Classic Mode, Word Chain Mode, and Room Heist Mode. You can learn more about rules on our dedicated How to Play pages.",
  },
];

export default function FAQPage() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        <header className="mb-10 text-center">
          <h1 className="text-4xl font-extrabold tracking-tight text-white sm:text-5xl">
            Frequently Asked Questions
          </h1>
          <p className="mt-4 text-lg text-slate-400">
            Everything you need to know about playing WordRush, rules, and game modes.
          </p>
        </header>

        <section className="space-y-6">
          {FAQS.map((faq, idx) => (
            <article
              key={idx}
              className="p-6 bg-slate-900 rounded-xl border border-slate-800 shadow-sm transition hover:border-slate-700"
            >
              <h2 className="text-xl font-bold text-emerald-400 mb-2">
                {faq.q}
              </h2>
              <p className="text-slate-300 leading-relaxed">
                {faq.a}
              </p>
            </article>
          ))}
        </section>

        <footer className="mt-12 pt-8 border-t border-slate-800 text-center">
          <p className="text-slate-400">
            Have more questions? Read our{" "}
            <Link href="/how-to-play/classic" className="text-emerald-400 hover:underline font-semibold">
              How to Play Guides
            </Link>{" "}
            or jump right into a game!
          </p>
          <div className="mt-6">
            <Link
              href="/"
              className="inline-flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-md text-slate-950 bg-emerald-400 hover:bg-emerald-300 transition"
            >
              Play WordRush Now
            </Link>
          </div>
        </footer>
      </div>
    </main>
  );
}
