"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { CreateBountyButton } from "@/components/features/CreateBountyButton";
import { CreateBountyModal } from "@/components/features/CreateBountyModal";
import { DealCarousel } from "@/components/features/DealCarousel";
import { TraderIndex } from "@/components/features/TraderIndex";

export default function Home() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  return (
    <div className="flex min-h-screen items-center justify-center bg-black font-sans pl-20">
      {/* Search Bar - Fixed at top center */}
      <div className="fixed top-8 left-1/2 -translate-x-1/2 z-40 w-full max-w-2xl px-4">
        <div className="relative">
          <Search className="absolute left-5 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search bounties..."
            className="w-full bg-[#0a0a0a] border border-white/10 rounded-xl py-4 pl-14 pr-5 text-base text-white placeholder-gray-500 focus:outline-none focus:border-white/20 transition-colors"
          />
        </div>
      </div>

      <main className="flex min-h-screen w-full max-w-5xl flex-col items-center justify-center py-32 px-8">
        <DealCarousel searchQuery={searchQuery} />
        <CreateBountyButton onClick={() => setIsModalOpen(true)} />
        <TraderIndex />
      </main>

      <CreateBountyModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
      />
    </div>
  );
}
