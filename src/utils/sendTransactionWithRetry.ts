import { Connection, Transaction, VersionedTransaction } from "@solana/web3.js";
import { sleep } from "./sleep";

interface CustomInstructionError {
  InstructionError?: [number, { Custom: number }];
}

/**
 * Sends a transaction with retry logic.
 *
 * @param connection - The connection to use.
 * @param signedTransaction - The signed transaction to send.
 * @param lastValidBlockHeight - The last valid block height.
 * @returns The signature of the transaction.
 */
export async function sendTransactionWithRetry(
  connection: Connection,
  signedTransaction: Transaction | VersionedTransaction,
  lastValidBlockHeight: number
): Promise<{
  signature: string;
  success: boolean;
  errorCode?: number;
  isSlippageError: boolean;
  isInsufficientBalanceError: boolean;
}> {
  let currentBlockHeight = await connection.getBlockHeight();
  let signature: string | undefined;

  while (currentBlockHeight < lastValidBlockHeight) {
    try {
      signature = await connection.sendRawTransaction(
        signedTransaction.serialize(),
        {
          skipPreflight: true,
          preflightCommitment: "confirmed",
          maxRetries: 0,
        }
      );

      await sleep(1000);

      const status = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });

      if (
        status &&
        (status.value[0]?.confirmationStatus === "confirmed" ||
          status.value[0]?.confirmationStatus === "finalized")
      ) {
        const err = status.value[0]?.err as CustomInstructionError;
        const errorCode = err?.InstructionError?.[1]?.Custom;
        const isSlippageError = errorCode === 6001;
        const isInsufficientBalanceError = errorCode === 1;
        return {
          signature,
          success: !status.value[0]?.err,
          errorCode,
          isSlippageError: isSlippageError || false,
          isInsufficientBalanceError: isInsufficientBalanceError || false,
        };
      }
    } catch (error) {
      console.error("Error sending transaction:", error);
    }

    signature = undefined;
    currentBlockHeight = await connection.getBlockHeight("confirmed");

    await sleep(1000);
  }

  if (!signature) {
    throw new Error("Transaction did not land.");
  }

  return {
    signature,
    success: false,
    isSlippageError: false,
    isInsufficientBalanceError: false,
  };
}