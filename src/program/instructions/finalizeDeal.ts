import { BN } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { getProgram, USDC_MINT } from "./createDeal";

export interface FinalizeDealArgs {
  volumeAtEndTime: BN;
  holdDurationAtEndTime: BN;
}

export interface DealAccount {
  dealId: BN;
  creator: PublicKey;
  trader: PublicKey;
  escrowVault: PublicKey;
}

export async function buildFinalizeDealInstruction(
  connection: Connection,
  payer: PublicKey,
  dealPubkey: PublicKey,
  dealAccount: DealAccount,
  args: FinalizeDealArgs,
  usdcMint: PublicKey = USDC_MINT
) {
  const program = getProgram(connection);

  const escrowVault = getAssociatedTokenAddressSync(
    usdcMint,
    dealPubkey,
    true, // allowOwnerOffCurve - deal PDA is the authority
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const traderTokenAccount = getAssociatedTokenAddressSync(
    usdcMint,
    dealAccount.trader,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const instruction = await program.methods
    .finalizeDeal({
      volumeAtEndTime: args.volumeAtEndTime,
      holdDurationAtEndTime: args.holdDurationAtEndTime,
    })
    .accountsStrict({
      payer: payer,
      trader: dealAccount.trader,
      creator: dealAccount.creator,
      deal: dealPubkey,
      escrowVault: escrowVault,
      traderTokenAccount: traderTokenAccount,
      usdcMint: usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return {
    instruction,
    dealPubkey,
    escrowVault,
    traderTokenAccount,
  };
}

export function logFinalizeDealDetails(
  payer: PublicKey,
  dealPubkey: PublicKey,
  dealAccount: DealAccount,
  args: FinalizeDealArgs
) {
  console.log("=== Finalize Deal Details ===");
  console.log("Payer:", payer.toBase58());
  console.log("Deal:", dealPubkey.toBase58());
  console.log("Trader:", dealAccount.trader.toBase58());
  console.log("Creator:", dealAccount.creator.toBase58());
  console.log("Volume at End Time:", args.volumeAtEndTime.toString());
  console.log("Hold Duration at End Time:", args.holdDurationAtEndTime.toString());
  console.log("==============================");
}
