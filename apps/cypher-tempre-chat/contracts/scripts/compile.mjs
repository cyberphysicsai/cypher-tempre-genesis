import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ContractFactory, getAddress, keccak256 } from 'ethers';
import { compile, root, runtimeBytecode } from './compiler.mjs';

const compilation = compile();
const { contracts, compiler, settings } = compilation;
const contract = contracts['src/CypherTempreSeats.sol'].CypherTempreSeats;
const artifact = {
  contractName: 'CypherTempreSeats',
  compiler,
  optimizer: settings.optimizer,
  evmVersion: settings.evmVersion,
  abi: contract.abi,
  bytecode: `0x${contract.evm.bytecode.object}`,
  deployedBytecodeTemplate: `0x${contract.evm.deployedBytecode.object}`,
  immutableReferences: contract.evm.deployedBytecode.immutableReferences,
  methodIdentifiers: contract.evm.methodIdentifiers,
};
const token = getAddress('0x08df470d41c11ba5cb60242747d76c65ca52c94c');
const treasury = getAddress('0x7932cca1bd502d6850842c423d21f527de47a0ca');
const factory = new ContractFactory(artifact.abi, artifact.bytecode);
const deployment = await factory.getDeployTransaction(token, treasury);
const expectedRuntimeBytecode = runtimeBytecode(compilation, token, treasury);
artifact.expectedBaseRuntimeBytecode = expectedRuntimeBytecode;
artifact.expectedBaseRuntimeSha256 = createHash('sha256').update(Buffer.from(expectedRuntimeBytecode.slice(2), 'hex')).digest('hex');
const manifest = {
  status: 'UNDEPLOYED_REVIEW_REQUIRED',
  chainId: 8453,
  network: 'Base Mainnet',
  token,
  treasury,
  unitPrice: '21000000000000000000000',
  constructorArguments: [token, treasury],
  sourceSha256: createHash('sha256').update(fs.readFileSync(path.join(root, 'src/CypherTempreSeats.sol'))).digest('hex'),
  creationBytecodeKeccak256: keccak256(artifact.bytecode),
  deploymentInputKeccak256: keccak256(deployment.data),
  expectedRuntimeSha256: artifact.expectedBaseRuntimeSha256,
  expectedRuntimeKeccak256: keccak256(expectedRuntimeBytecode),
  transaction: { chainId: '0x2105', to: null, value: '0x0', data: deployment.data },
  note: 'Prepared only. A wallet owner must review and submit deployment, then verify source and immutable settings before enabling paid access. Gas is not estimated or paid by this script.',
};
const directory = path.join(root, 'artifacts');
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'CypherTempreSeats.json'), `${JSON.stringify(artifact, null, 2)}\n`);
fs.writeFileSync(path.join(directory, 'CypherTempreSeats.abi.json'), `${JSON.stringify(artifact.abi, null, 2)}\n`);
fs.writeFileSync(path.join(directory, 'base-deployment.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ compiler, bytecodeBytes: contract.evm.bytecode.object.length / 2, ...manifest, transaction: '[prepared in artifacts/base-deployment.json]' }, null, 2));
