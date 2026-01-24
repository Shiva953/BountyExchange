"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { Grid3x3, Home, ShoppingBag, Zap } from "lucide-react";
import {} from "react-icons/fa"

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

  // Check if current path matches trader route pattern
  const isTraderPage = publicKey && pathname?.startsWith(`/${publicKey.toBase58()}/deals`);

  return (
    <>
      {/* Left Vertical Navigation */}
      <nav className="fixed left-0 top-0 bottom-0 z-50 w-20 flex flex-col items-center py-6 bg-black border-r border-white/10">
        {/* Logo at top */}
        <Link href="/" className="mb-8">
          <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-[#ff6b8a] to-[#ff8fa3] flex items-center justify-center hover:from-[#ff8fa3] hover:to-[#ff6b8a] transition-all duration-200">
            <Zap className="text-white text-2xl fill-white" />
          </div>
        </Link>

        {/* Navigation Links */}
        <div className="flex flex-col gap-4 flex-1">
          <Link
            href="/"
            className={`flex flex-col items-center justify-center w-14 h-14 rounded-xl transition-all duration-200 ${
              pathname === "/"
                ? "bg-white/10 text-[#ff6b8a]"
                : "text-zinc-500 hover:bg-white/5 hover:text-white"
            }`}
            title="Market"
          >
            <Grid3x3 className="w-5 h-5" />
            <span className="text-[10px] mt-1 font-medium">Market</span>
          </Link>
          
          {publicKey && (
            <Link
              href={`/${publicKey.toBase58()}/deals`}
              className={`flex flex-col items-center justify-center w-14 h-14 rounded-xl transition-all duration-200 ${
                isTraderPage
                  ? "bg-white/10 text-[#ff6b8a]"
                  : "text-zinc-500 hover:bg-white/5 hover:text-white"
              }`}
              title="Trader"
            >
              <ShoppingBag className="w-5 h-5" />
              <span className="text-[10px] mt-1 font-medium">Trader</span>
            </Link>
          )}
        </div>
      </nav>

      {/* Top Right Wallet Button */}
      <div className="fixed top-6 right-6 z-50">
        <WalletMultiButton />
      </div>
    </>
  );
};