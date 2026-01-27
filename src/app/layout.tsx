import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SolanaProvider } from "@/components/providers/SolanaProvider";
import { WalletGate } from "@/components/providers/WalletGate";
import { Navbar } from "@/components/layout/Navbar";
import { Toaster } from "sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Bounty Exchange",
  description: "A token-based bounty platform for creators.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <SolanaProvider>
          <Navbar />
          <WalletGate>{children}</WalletGate>
          <Toaster theme="dark" position="bottom-right" />
        </SolanaProvider>
      </body>
    </html>
  );
}
