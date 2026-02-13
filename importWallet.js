import { Wallet, HDNodeWallet } from 'ethers';
import { Mnemonic } from 'ethers';

// Sua seed phrase (NUNCA compartilhe em público se for real)
const mnemonicPhrase = "ball pupil style april chat grace oyster master ozone tattoo debate opera";

// Gera o HDNodeWallet a partir da seed
const mnemonic = Mnemonic.fromPhrase(mnemonicPhrase);
const wallet = HDNodeWallet.fromMnemonic(mnemonic);

// Exibe o endereço e a chave privada no console
console.log("Endereço:", wallet.address);
console.log("Chave privada:", wallet.privateKey);
