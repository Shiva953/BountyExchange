"use client";

import dynamic from "next/dynamic";

const WalletMultiButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then(
      (mod) => mod.WalletMultiButton
    ),
  { ssr: false }
);

export const Navbar = () => {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4 bg-white/80 dark:bg-black/80 backdrop-blur-sm border-b border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center gap-2">
        <span className="text-lg font-semibold text-zinc-900 dark:text-white">
          Bounty Exchange
        </span>
      </div>
      <div className="flex items-center">
        <WalletMultiButton />
      </div>
    </nav>
  );
};
