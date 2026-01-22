"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { Home, FileText } from "lucide-react";

const WalletMultiButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then(
      (mod) => mod.WalletMultiButton
    ),
  { ssr: false }
);

export const Navbar = () => {
  const pathname = usePathname();
  const { publicKey } = useWallet();

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4 bg-white/80 dark:bg-black/80 backdrop-blur-sm border-b border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center gap-12">
        <span className="text-lg font-semibold text-zinc-900 dark:text-white">
          Bounty Exchange
        </span>
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
              pathname === "/"
                ? "bg-[#2a1a1a]/80 text-[#ff6b8a]"
                : "text-zinc-500 dark:text-zinc-400 hover:bg-[#2a1a1a]/80 hover:!text-[#ff6b8a]"
            }`}
          >
            <Home className="w-4 h-4" />
            Home
          </Link>
          {publicKey && (
            <Link
              href={`/${publicKey.toBase58()}/deals`}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                pathname === `/${publicKey.toBase58()}/deals`
                  ? "bg-[#2a1a1a]/80 text-[#ff6b8a]"
                  : "text-zinc-500 dark:text-zinc-400 hover:bg-[#2a1a1a]/80 hover:!text-[#ff6b8a]"
              }`}
            >
              <FileText className="w-4 h-4" />
              My Deals
            </Link>
          )}
        </div>
      </div>
      <div className="flex items-center">
        <WalletMultiButton />
      </div>
    </nav>
  );
};
