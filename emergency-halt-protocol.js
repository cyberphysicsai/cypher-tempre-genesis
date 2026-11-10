export const HALT_CHAIN_ID = 8453;
export const HALT_CPHY_TOKEN = '0x08df470d41c11ba5cb60242747d76c65ca52c94c';
export const HALT_ZERO_HASH = '0x' + '0'.repeat(64);
export const HALT_WALLET_LIFETIME_SECONDS = 15 * 60;
export const HALT_CPHY_LIFETIME_SECONDS = 60 * 60;

export function emergencyHaltTypedData({ installationId, nonce, expiresAt, transactionHash }) {
  return {
    domain: { name: 'ChainChat Emergency Halt', version: '1', chainId: HALT_CHAIN_ID, salt: installationId },
    primaryType: 'Halt',
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' }, { name: 'salt', type: 'bytes32' },
      ],
      Halt: [
        { name: 'action', type: 'string' }, { name: 'nonce', type: 'bytes32' },
        { name: 'expiresAt', type: 'uint64' }, { name: 'transactionHash', type: 'bytes32' },
      ],
    },
    message: { action: 'halt', nonce, expiresAt, transactionHash },
  };
}
