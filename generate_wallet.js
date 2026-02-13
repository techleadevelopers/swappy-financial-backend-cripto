import { Wallet } from 'ethers';

// Esta linha cria uma nova carteira com uma chave privada aleatória
const wallet = Wallet.createRandom();

console.log('##########################################');
console.log('## NOVA CARTEIRA DE TESTE GERADA        ##');
console.log('##########################################');
console.log('Endereço Público (use para receber fundos de TESTE):');
console.log(wallet.address);
console.log('\n'); // Adiciona uma linha em branco para separar
console.log('Chave Privada (USE APENAS PARA TESTE NESTE PROJETO):');
console.log(wallet.privateKey); // ESTA É A CHAVE QUE VOCÊ PRECISA COPIAR
console.log('##########################################');
console.log('## SALVE ESTES DADOS EM LOCAL SEGURO    ##');
console.log('## E NUNCA USE UMA CHAVE REAL AQUI!   ##');
console.log('##########################################');