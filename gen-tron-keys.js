import { generateMnemonic, mnemonicToSeedSync } from 'bip39';
import { HDKey } from '@scure/bip32';
import TronWebPkg from 'tronweb';

const TronWebCtor = TronWebPkg.TronWeb || TronWebPkg.default || TronWebPkg;
const tronWeb = new TronWebCtor({
  fullHost: 'https://api.trongrid.io',
  privateKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' // dummy
});

const mnemonic = generateMnemonic(256); // 24 palavras
const seed = mnemonicToSeedSync(mnemonic);
const master = HDKey.fromMasterSeed(seed);

// BIP44 TRON: m/44'/195'/0'
const account = master.derive("m/44'/195'/0'");
const xprv = account.privateExtendedKey;
const xpub = account.publicExtendedKey;

// Derive alguns endereços filhos para teste (caminho /0/i)
for (let i = 0; i < 3; i++) {
  const child = account.derive(`m/0/${i}`);
  const addrHex = tronWeb.utils.crypto.computeAddress(child.publicKey);
  const addrBase58 = tronWeb.utils.crypto.getBase58CheckAddress(addrHex);
  console.log(`child ${i}: ${addrBase58}`);
}

console.log({ mnemonic, xprv, xpub });
