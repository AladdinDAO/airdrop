import * as fs from "fs";
import { Command } from "commander";
import { parse } from "csv-parse/sync";
import {
  Contract,
  JsonRpcProvider,
  ZeroHash,
  ethers,
  getAddress,
  keccak256,
  solidityPackedKeccak256,
  toBigInt,
} from "ethers";
import MerkleTree from "merkletreejs";

const program = new Command();
program.version("1.0.0");

interface IMerkleClaimInfo {
  symbol: string;
  address: string;
  date: string;
  merkleRoot: string;
  total: string;
  claims: {
    [address: string]: {
      index: number;
      amount: string;
      proof: Array<string>;
    };
  };
}

const MultiMerkleStashABI = [
  "function merkleRoot(address) external view returns (bytes32)",
  "function update(address) external view returns (uint256)",
];

function computeSlot(token: string, update: bigint, index: bigint): string {
  const encoder = ethers.AbiCoder.defaultAbiCoder();
  return keccak256(
    encoder.encode(
      ["uint256", "bytes32"],
      [
        index,
        keccak256(
          encoder.encode(
            ["uint256", "bytes32"],
            [
              update,
              keccak256(encoder.encode(["address", "uint256"], [token, 3])),
            ]
          )
        ),
      ]
    )
  );
}

async function main(
  tokenSymbol: string,
  tokenAddress: string,
  csvFile: string
) {
  tokenAddress = getAddress(tokenAddress); // make sure with checksum
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const filename = `merkles/${tokenSymbol}/latest.json`;
  if (!fs.existsSync(`merkles/${tokenSymbol}`)) {
    fs.mkdirSync(`merkles/${tokenSymbol}`, { recursive: true });
  }

  let last: IMerkleClaimInfo;
  if (!fs.existsSync(filename)) {
    last = {
      symbol: tokenSymbol,
      address: tokenAddress,
      date,
      merkleRoot: "",
      total: "0",
      claims: {},
    };
  } else {
    last = JSON.parse(fs.readFileSync(filename).toString());
  }

  // load new airdrop
  const cvsFile = fs.readFileSync(csvFile);
  let records = parse(cvsFile, {
    columns: true,
    skip_empty_lines: true,
    delimiter: ",",
  });
  const rewards: { [address: string]: bigint } = {};
  for (const row of records) {
    const address = getAddress((row as any).address);
    const amount = toBigInt((row as any).amount);
    rewards[address] = amount;
  }

  // load on-chain data
  if (last.merkleRoot !== "") {
    const provider = new JsonRpcProvider("https://rpc.phalcon.blocksec.com/rpc_9ef21376be7646789cd2d3c8653ac70a");
    const contract = new Contract(
      "0xaBC6A4e345801Cb5f57629E79Cd5Eb2e9e514e98",
      MultiMerkleStashABI,
      provider
    );
    const root: string = await contract.merkleRoot(tokenAddress);
    if (root !== ZeroHash) {
      throw new Error("MultiMerkleStash not paused");
    }
    const update: bigint = await contract.update(tokenAddress);
    const length = Object.keys(last.claims).length;
    const bitmap: Array<bigint> = [];
    for (let i = 0; i < length; i += 256) {
      const slot = computeSlot(tokenAddress, update - 1n, toBigInt(i));
      const data = await provider.getStorage(await contract.getAddress(), slot);
      const value: bigint = ethers.AbiCoder.defaultAbiCoder().decode(
        ["uint256"],
        data
      )[0];
      bitmap.push(value);
    }
    for (const [address, info] of Object.entries(last.claims)) {
      const bucket = Math.floor(info.index / 256);
      const offset = info.index % 256;
      if ((bitmap[bucket] & (1n << toBigInt(offset))) === 0n) {
        if (rewards[address] === undefined) rewards[address] = 0n;
        rewards[address] += toBigInt(info.amount);
      }
    }
  }

  const addresses = Object.keys(rewards);
  const elements: Array<string> = [];
  for (let i = 0; i < addresses.length; i++) {
    const amount = rewards[addresses[i]];
    const data = solidityPackedKeccak256(
      ["uint256", "address", "uint256"],
      [i, addresses[i], amount]
    );
    elements.push(data);
  }
  const merkleTree = new MerkleTree(elements, keccak256, { sort: true });
  last.claims = {};
  for (let i = 0; i < addresses.length; i++) {
    const amount = rewards[addresses[i]];
    last.claims[addresses[i]] = {
      index: i,
      amount: amount.toString(),
      proof: merkleTree.getHexProof(elements[i]),
    };
  }

  if (last.date !== date) {
    fs.renameSync(filename, `merkles/${tokenSymbol}/${last.date}.json`);
  }
  let total = 0n;
  for (const amount of Object.values(rewards)) {
    total += amount;
  }
  last.total = total.toString();
  last.merkleRoot = merkleTree.getHexRoot();
  last.date = date;
  fs.writeFileSync(filename, JSON.stringify(last, null, 2));
}

program.option("--symbol <symbol>", "token symbol");
program.option("--address <address>", "token address");
program.option("--csv <csv>", "the airdrop data in csv format");
program.parse(process.argv);
const options = program.opts();

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main(options.symbol, options.address, options.csv).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
