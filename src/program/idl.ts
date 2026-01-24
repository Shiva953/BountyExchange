/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/bounty_exchange_program.json`.
 */
export type BountyExchangeProgram = {
  "address": "9c3ZGDTinPuGXxJGaN3QsNRBcDgkkjcsNgXgcoqoGW8D",
  "metadata": {
    "name": "bountyExchangeProgram",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "acceptDeal",
      "discriminator": [
        76,
        156,
        34,
        30,
        129,
        136,
        76,
        244
      ],
      "accounts": [
        {
          "name": "trader",
          "writable": true,
          "signer": true
        },
        {
          "name": "deal",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "createDeal",
      "discriminator": [
        198,
        212,
        144,
        151,
        97,
        56,
        149,
        113
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "deal",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "payer"
              },
              {
                "kind": "arg",
                "path": "args.deal_id"
              }
            ]
          }
        },
        {
          "name": "escrowVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "deal"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "payerTokenAccount",
          "writable": true
        },
        {
          "name": "feeWallet",
          "writable": true
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "createDealArgs"
            }
          }
        }
      ]
    },
    {
      "name": "finalizeDeal",
      "discriminator": [
        20,
        13,
        62,
        64,
        17,
        110,
        130,
        148
      ],
      "accounts": [
        {
          "name": "trader",
          "writable": true,
          "signer": true
        },
        {
          "name": "creator"
        },
        {
          "name": "deal",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "creator"
              },
              {
                "kind": "account",
                "path": "deal.deal_id",
                "account": "deal"
              }
            ]
          }
        },
        {
          "name": "escrowVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "deal"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "traderTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "trader"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "finalizeDealArgs"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "deal",
      "discriminator": [
        125,
        223,
        160,
        234,
        71,
        162,
        182,
        219
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidFeeWallet",
      "msg": "Invalid fee wallet"
    },
    {
      "code": 6001,
      "name": "rewardBelowMinimum",
      "msg": "Minimum reward amount is 200 USDC"
    },
    {
      "code": 6002,
      "name": "unauthorizedTrader",
      "msg": "Only the targeted trader can accept this deal"
    },
    {
      "code": 6003,
      "name": "dealNotActive",
      "msg": "Deal is not active"
    },
    {
      "code": 6004,
      "name": "dealAlreadyAccepted",
      "msg": "Deal has already been accepted"
    },
    {
      "code": 6005,
      "name": "selfTargetedDeal",
      "msg": "Cannot create a bounty targeting yourself"
    },
    {
      "code": 6006,
      "name": "dealNotAccepted",
      "msg": "Deal has not been accepted yet"
    },
    {
      "code": 6007,
      "name": "invalidCreator",
      "msg": "Invalid creator account"
    },
    {
      "code": 6008,
      "name": "invalidEscrowVault",
      "msg": "Invalid escrow vault"
    },
    {
      "code": 6009,
      "name": "dealExpired",
      "msg": "Deal has expired"
    },
    {
      "code": 6010,
      "name": "volumeRequirementNotMet",
      "msg": "Volume requirement not met"
    },
    {
      "code": 6011,
      "name": "holdDurationRequirementNotMet",
      "msg": "Hold duration requirement not met"
    },
    {
      "code": 6012,
      "name": "minBuyVolumeExceedsTarget",
      "msg": "Minimum buy volume must be less than target volume"
    }
  ],
  "types": [
    {
      "name": "createDealArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "dealId",
            "type": "u64"
          },
          {
            "name": "token",
            "type": "pubkey"
          },
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "rewardAmount",
            "type": "u64"
          },
          {
            "name": "targetVolume",
            "type": "u64"
          },
          {
            "name": "minBuyVolume",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "expirationWindowInHours",
            "type": "u64"
          },
          {
            "name": "holdDurationInHours",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "deal",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "dealId",
            "type": "u64"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "token",
            "type": "pubkey"
          },
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "rewardAmount",
            "type": "u64"
          },
          {
            "name": "targetVolume",
            "type": "u64"
          },
          {
            "name": "minBuyVolume",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "expirationWindowInHours",
            "type": "u64"
          },
          {
            "name": "holdDurationInHours",
            "type": "u64"
          },
          {
            "name": "escrowVault",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "isActive",
            "type": "bool"
          },
          {
            "name": "isAccepted",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "finalizeDealArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "volumeAtEndTime",
            "type": "u64"
          },
          {
            "name": "holdDurationAtEndTime",
            "type": "u64"
          }
        ]
      }
    }
  ]
};