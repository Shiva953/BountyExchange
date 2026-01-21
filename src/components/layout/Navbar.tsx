"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";

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
      <div className="flex items-center gap-6">
        <span className="text-lg font-semibold text-zinc-900 dark:text-white">
          Bounty Exchange
        </span>
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className={`text-sm font-medium transition-colors ${
              pathname === "/"
                ? "text-zinc-900 dark:text-white"
                : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
            }`}
          >
            Home
          </Link>
          {publicKey && (
            <Link
              href={`/${publicKey.toBase58()}/deals`}
              className={`text-sm font-medium transition-colors ${
                pathname === `/${publicKey.toBase58()}/deals`
                  ? "text-zinc-900 dark:text-white"
                  : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
              }`}
            >
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
