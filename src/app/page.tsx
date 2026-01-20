"use client";

import { useState } from "react";
import { CreateBountyButton } from "@/components/features/CreateBountyButton";
import { CreateBountyModal } from "@/components/features/CreateBountyModal";

export default function Home() {
  const [isModalOpen, setIsModalOpen] = useState(false);

  return (
    <div className="flex min-h-screen items-center justify-center bg-black font-sans pt-16">
      <main className="flex min-h-screen w-full max-w-3xl flex-col items-center justify-center py-32 px-16">
        <CreateBountyButton onClick={() => setIsModalOpen(true)} />
      </main>

      <CreateBountyModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
      />
    </div>
  );
}
