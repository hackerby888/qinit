// Generated from core-lite Wasm shared ABI headers. Do not edit.
export const WASM_ABI_METADATA = {
  "abiVersion": 4,
  "lhost": [
    {
      "name": "beginFn",
      "params": [
        "i32"
      ],
      "results": []
    },
    {
      "name": "endFn",
      "params": [
        "i32"
      ],
      "results": []
    },
    {
      "name": "markDirty",
      "params": [
        "i32"
      ],
      "results": []
    },
    {
      "name": "pauseLog",
      "params": [],
      "results": []
    },
    {
      "name": "resumeLog",
      "params": [],
      "results": []
    },
    {
      "name": "acquireScratch",
      "params": [
        "i64",
        "i32"
      ],
      "results": [
        "i32"
      ]
    },
    {
      "name": "releaseScratch",
      "params": [
        "i32"
      ],
      "results": []
    },
    {
      "name": "logBytes",
      "params": [
        "i32",
        "i32",
        "i32",
        "i32"
      ],
      "results": []
    },
    {
      "name": "k12",
      "params": [
        "i32",
        "i32",
        "i32"
      ],
      "results": []
    },
    {
      "name": "transfer",
      "params": [
        "i32",
        "i64"
      ],
      "results": [
        "i64"
      ]
    },
    {
      "name": "transferTyped",
      "params": [
        "i32",
        "i64",
        "i32"
      ],
      "results": [
        "i64"
      ]
    },
    {
      "name": "abort",
      "params": [
        "i32"
      ],
      "results": []
    },
    {
      "name": "burn",
      "params": [
        "i64",
        "i32"
      ],
      "results": [
        "i64"
      ]
    },
    {
      "name": "epoch",
      "params": [],
      "results": [
        "i32"
      ]
    },
    {
      "name": "tick",
      "params": [],
      "results": [
        "i32"
      ]
    },
    {
      "name": "numberOfTickTransactions",
      "params": [],
      "results": [
        "i32"
      ]
    },
    {
      "name": "getEntity",
      "params": [
        "i32",
        "i32"
      ],
      "results": [
        "i32"
      ]
    },
    {
      "name": "queryFeeReserve",
      "params": [
        "i32"
      ],
      "results": [
        "i64"
      ]
    },
    {
      "name": "nextId",
      "params": [
        "i32",
        "i32"
      ],
      "results": []
    },
    {
      "name": "prevId",
      "params": [
        "i32",
        "i32"
      ],
      "results": []
    },
    {
      "name": "isContractId",
      "params": [
        "i32"
      ],
      "results": [
        "i32"
      ]
    },
    {
      "name": "arbitrator",
      "params": [
        "i32"
      ],
      "results": []
    },
    {
      "name": "computor",
      "params": [
        "i32",
        "i32"
      ],
      "results": []
    },
    {
      "name": "day",
      "params": [],
      "results": [
        "i32"
      ]
    },
    {
      "name": "year",
      "params": [],
      "results": [
        "i32"
      ]
    },
    {
      "name": "hour",
      "params": [],
      "results": [
        "i32"
      ]
    },
    {
      "name": "minute",
      "params": [],
      "results": [
        "i32"
      ]
    },
    {
      "name": "month",
      "params": [],
      "results": [
        "i32"
      ]
    },
    {
      "name": "second",
      "params": [],
      "results": [
        "i32"
      ]
    },
    {
      "name": "millisecond",
      "params": [],
      "results": [
        "i32"
      ]
    },
    {
      "name": "now",
      "params": [
        "i32"
      ],
      "results": []
    },
    {
      "name": "prevSpectrumDigest",
      "params": [
        "i32"
      ],
      "results": []
    },
    {
      "name": "prevUniverseDigest",
      "params": [
        "i32"
      ],
      "results": []
    },
    {
      "name": "prevComputerDigest",
      "params": [
        "i32"
      ],
      "results": []
    },
    {
      "name": "isAssetIssued",
      "params": [
        "i32",
        "i64"
      ],
      "results": [
        "i32"
      ]
    },
    {
      "name": "issueAsset",
      "params": [
        "i64",
        "i32",
        "i32",
        "i64",
        "i64"
      ],
      "results": [
        "i64"
      ]
    },
    {
      "name": "numberOfShares",
      "params": [
        "i32",
        "i32",
        "i32"
      ],
      "results": [
        "i64"
      ]
    },
    {
      "name": "numberOfPossessedShares",
      "params": [
        "i64",
        "i32",
        "i32",
        "i32",
        "i32",
        "i32"
      ],
      "results": [
        "i64"
      ]
    },
    {
      "name": "assetEnumerate",
      "params": [
        "i32",
        "i32",
        "i32",
        "i32",
        "i32",
        "i32"
      ],
      "results": [
        "i32"
      ]
    },
    {
      "name": "transferShareOwnershipAndPossession",
      "params": [
        "i64",
        "i32",
        "i32",
        "i32",
        "i64",
        "i32"
      ],
      "results": [
        "i64"
      ]
    },
    {
      "name": "acquireShares",
      "params": [
        "i64",
        "i32",
        "i32",
        "i32",
        "i64",
        "i32",
        "i32",
        "i64"
      ],
      "results": [
        "i64"
      ]
    },
    {
      "name": "releaseShares",
      "params": [
        "i64",
        "i32",
        "i32",
        "i32",
        "i64",
        "i32",
        "i32",
        "i64"
      ],
      "results": [
        "i64"
      ]
    },
    {
      "name": "dayOfWeek",
      "params": [
        "i32",
        "i32",
        "i32"
      ],
      "results": [
        "i32"
      ]
    },
    {
      "name": "signatureValidity",
      "params": [
        "i32",
        "i32",
        "i32"
      ],
      "results": [
        "i32"
      ]
    },
    {
      "name": "bidInIPO",
      "params": [
        "i32",
        "i64",
        "i32"
      ],
      "results": [
        "i64"
      ]
    },
    {
      "name": "ipoBidId",
      "params": [
        "i32",
        "i32",
        "i32"
      ],
      "results": []
    },
    {
      "name": "ipoBidPrice",
      "params": [
        "i32",
        "i32"
      ],
      "results": [
        "i64"
      ]
    },
    {
      "name": "computeMiningFunction",
      "params": [
        "i32",
        "i32",
        "i32",
        "i32"
      ],
      "results": []
    },
    {
      "name": "initMiningSeed",
      "params": [
        "i32"
      ],
      "results": []
    },
    {
      "name": "getOracleQueryStatus",
      "params": [
        "i64"
      ],
      "results": [
        "i32"
      ]
    },
    {
      "name": "unsubscribeOracle",
      "params": [
        "i32"
      ],
      "results": [
        "i32"
      ]
    },
    {
      "name": "queryOracle",
      "params": [
        "i32",
        "i32",
        "i32",
        "i32",
        "i32",
        "i32",
        "i64"
      ],
      "results": [
        "i64"
      ]
    },
    {
      "name": "subscribeOracle",
      "params": [
        "i32",
        "i32",
        "i32",
        "i32",
        "i32",
        "i32",
        "i32",
        "i32",
        "i64"
      ],
      "results": [
        "i32"
      ]
    },
    {
      "name": "getOracleQuery",
      "params": [
        "i64",
        "i32",
        "i32"
      ],
      "results": [
        "i32"
      ]
    },
    {
      "name": "getOracleReply",
      "params": [
        "i64",
        "i32",
        "i32"
      ],
      "results": [
        "i32"
      ]
    },
    {
      "name": "distributeDividends",
      "params": [
        "i64"
      ],
      "results": [
        "i32"
      ]
    },
    {
      "name": "liteCallFunction",
      "params": [
        "i32",
        "i32",
        "i32",
        "i32",
        "i32",
        "i32"
      ],
      "results": [
        "i32"
      ]
    },
    {
      "name": "liteInvokeProcedure",
      "params": [
        "i32",
        "i32",
        "i32",
        "i32",
        "i32",
        "i32",
        "i64"
      ],
      "results": [
        "i32"
      ]
    },
    {
      "name": "liteSetShareholderProposal",
      "params": [
        "i32",
        "i32",
        "i64"
      ],
      "results": [
        "i32"
      ]
    },
    {
      "name": "liteSetShareholderVotes",
      "params": [
        "i32",
        "i32",
        "i32",
        "i64"
      ],
      "results": [
        "i32"
      ]
    }
  ],
  "systemProcedures": [
    {
      "name": "INITIALIZE",
      "id": 0,
      "method": "initialize"
    },
    {
      "name": "BEGIN_EPOCH",
      "id": 1,
      "method": "beginEpoch"
    },
    {
      "name": "END_EPOCH",
      "id": 2,
      "method": "endEpoch"
    },
    {
      "name": "BEGIN_TICK",
      "id": 3,
      "method": "beginTick"
    },
    {
      "name": "END_TICK",
      "id": 4,
      "method": "endTick"
    },
    {
      "name": "PRE_RELEASE_SHARES",
      "id": 5,
      "method": "preReleaseShares"
    },
    {
      "name": "PRE_ACQUIRE_SHARES",
      "id": 6,
      "method": "preAcquireShares"
    },
    {
      "name": "POST_RELEASE_SHARES",
      "id": 7,
      "method": "postReleaseShares"
    },
    {
      "name": "POST_ACQUIRE_SHARES",
      "id": 8,
      "method": "postAcquireShares"
    },
    {
      "name": "POST_INCOMING_TRANSFER",
      "id": 9,
      "method": "postIncomingTransfer"
    },
    {
      "name": "SET_SHAREHOLDER_PROPOSAL",
      "id": 10,
      "method": "setShareholderProposal"
    },
    {
      "name": "SET_SHAREHOLDER_VOTES",
      "id": 11,
      "method": "setShareholderVotes"
    }
  ],
  "records": {
    "AssetEntry": {
      "size": 80,
      "capacity": 1024,
      "fields": {
        "owner": {
          "offset": 0,
          "size": 32
        },
        "possessor": {
          "offset": 32,
          "size": 32
        },
        "shares": {
          "offset": 64,
          "size": 8
        },
        "ownershipManagingContract": {
          "offset": 72,
          "size": 2
        },
        "possessionManagingContract": {
          "offset": 74,
          "size": 2
        },
        "padding": {
          "offset": 76,
          "size": 4
        }
      }
    }
  }
} as const;
