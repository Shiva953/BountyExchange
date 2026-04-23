import { BN } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { getProgram, USDC_MINT } from "./createDeal";

export interface CancelExpiredDealAccount {
  dealId: BN;
  creator: PublicKey;
  escrowVault: PublicKey;
}

export async function buildCancelExpiredDealInstruction(
  connection: Connection,
  payer: PublicKey,
  dealPubkey: PublicKey,
  dealAccount: CancelExpiredDealAccount,
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

  const creatorTokenAccount = getAssociatedTokenAddressSync(
    usdcMint,
    dealAccount.creator,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const instruction = await program.methods
    .cancelExpiredDeal()
    .accountsStrict({
      payer: payer,
      creator: dealAccount.creator,
      deal: dealPubkey,
      escrowVault: escrowVault,
      creatorTokenAccount: creatorTokenAccount,
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
    creatorTokenAccount,
  };
}
