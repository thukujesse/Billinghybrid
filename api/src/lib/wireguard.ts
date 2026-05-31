import crypto from 'node:crypto';

export interface WgKeypair {
  privateKey: string;
  publicKey: string;
}

/**
 * Generate a WireGuard X25519 keypair. WG keys are 32 raw bytes base64-encoded.
 * Node's crypto returns DER-wrapped keys; the last 32 bytes are the raw key.
 */
export function generateWgKeypair(): WgKeypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    privateKey: priv.toString('base64'),
    publicKey: pub.toString('base64'),
  };
}
