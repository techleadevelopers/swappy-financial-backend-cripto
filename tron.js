import TronWebPkg from 'tronweb';
import { HDKey } from '@scure/bip32';
import { config } from './config.js';

const TronWeb = TronWebPkg?.TronWeb || TronWebPkg?.default?.TronWeb || TronWebPkg;

const tronWeb = new TronWeb({
  fullHost: config.tronFullNodeUrl || 'https://api.trongrid.io',
  solidityNode: config.tronSolidityUrl || config.tronFullNodeUrl || 'https://api.trongrid.io',
  eventServer: config.tronSolidityUrl || config.tronFullNodeUrl || 'https://api.trongrid.io',
  privateKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' // dummy; not used for signing
});

export function deriveTronAddress(index) {
  if (!config.tronXpub) {
    throw new Error('TRON_XPUB not configured');
  }
  const hd = HDKey.fromExtendedKey(config.tronXpub);
  const child = hd.deriveChild(index);
  if (!child.publicKey) throw new Error('Failed to derive public key');
  const hex = TronWeb.utils.crypto.computeAddress(child.publicKey);
  const base58 = TronWeb.utils.crypto.getBase58CheckAddress(hex);
  return base58;
}

export function isTronAddress(addr) {
  return TronWeb.isAddress(addr);
}
