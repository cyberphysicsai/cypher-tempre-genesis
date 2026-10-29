import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function compile(extraSources = {}) {
  const sources = {
    'src/CypherTempreSeats.sol': {
      content: fs.readFileSync(path.join(root, 'src/CypherTempreSeats.sol'), 'utf8'),
    },
    ...extraSources,
  };
  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris',
      outputSelection: {
        '*': { '': ['ast'], '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'evm.methodIdentifiers'] },
      },
    },
  };
  const result = JSON.parse(solc.compile(JSON.stringify(input), {
    import(importPath) {
      if (!importPath.startsWith('@openzeppelin/contracts/')) return { error: 'Unsupported import' };
      const resolved = path.resolve(root, 'node_modules', importPath);
      if (!resolved.startsWith(path.resolve(root, 'node_modules/@openzeppelin/contracts') + path.sep)) return { error: 'Import outside dependency' };
      try { return { contents: fs.readFileSync(resolved, 'utf8') }; }
      catch { return { error: `Missing dependency: ${importPath}` }; }
    },
  }));
  const failures = (result.errors || []).filter(item => item.severity === 'error');
  if (failures.length) throw new Error(failures.map(item => item.formattedMessage).join('\n'));
  return { contracts: result.contracts, sources: result.sources, compiler: solc.version(), settings: input.settings };
}

export function runtimeBytecode(compilation, tokenAddress, treasuryAddress) {
  const file = 'src/CypherTempreSeats.sol';
  const definition = compilation.sources[file].ast.nodes.find(node => node.nodeType === 'ContractDefinition' && node.name === 'CypherTempreSeats');
  const names = Object.fromEntries(definition.nodes.filter(node => node.nodeType === 'VariableDeclaration' && node.mutability === 'immutable').map(node => [String(node.id), node.name]));
  const contract = compilation.contracts[file].CypherTempreSeats;
  const runtime = Buffer.from(contract.evm.deployedBytecode.object, 'hex');
  const values = { token: tokenAddress, treasury: treasuryAddress };
  for (const [id, locations] of Object.entries(contract.evm.deployedBytecode.immutableReferences)) {
    const value = values[names[id]];
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`Unknown immutable ${names[id]}`);
    const encoded = Buffer.from(value.slice(2).padStart(64, '0'), 'hex');
    for (const { start, length } of locations) {
      if (length !== encoded.length) throw new Error('Unexpected immutable width');
      encoded.copy(runtime, start);
    }
  }
  return `0x${runtime.toString('hex')}`;
}
