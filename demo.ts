import { prompt } from 'inquirer';
import { SlpdbQueries } from './query';
import { GrpcClient } from 'grpc-bchrpc-node';
import * as readline from 'readline'
import Big from 'big.js';
let Bchaddr = require('bchaddrjs-slp');
let Spinner = require('cli-spinner').Spinner;

let args = process.argv.slice(2);
let client: GrpcClient;
let customUrl, certPath: string;
if(args.includes('--bchd-rootcert') && args.includes('--bchd-url')) {
    certPath = args[args.indexOf('--bchd-rootcert') + 1]
    customUrl = args[args.indexOf('--bchd-url') + 1]
    client = new GrpcClient({ url: customUrl, rootCertPath: certPath });
} else if(args.includes('--bchdurl')) {
    customUrl = args[args.indexOf('--bchd-url') + 1]
    client = new GrpcClient({ url: customUrl });
}
else {
    client = new GrpcClient();
}

(async function() {
    const slpdb_hosts: {[key:string]: string[]} = {
        'mainnet': ['https://slpdb.bitcoin.com', 'https://slpdb.fountainhead.cash', 'https://slpserve.imaginary.cash', 'http://localhost:3000'], 
        'testnet': ['https://tslpdb.bitcoin.com', 'http://localhost:3000']
    };
    
    const app_mode: string = (await prompt([
        {
            type: 'list',
            name: 'mode',
            message: 'What would you like to do?',
            choices: [
                {
                    value: 'slp_shareholder_list',
                    name: 'Get list of SLP token holders and balances.'
                },
                {
                    value: 'bch_dividend_list',
                    name: 'Get list of SLP token holders and calculated BCH pro-rata dividend.'
                },
                {
                    value: 'slp_airdrop_list',
                    name: 'Get list of SLP token holders and calculated SLP airdrop pro-rata.'
                }
            ]
        }
    ])).mode;

    const bch_network: string = (await prompt([
        {
            type: 'list', 
            name: 'bch_network', 
            message: 'Choose BCH network:',
            choices: ['Mainnet', 'Testnet'], 
            filter: function(net:string) { return net.toLowerCase(); }
        }
    ])).bch_network;

    let minHeight = 543375;
    let minMtp = 1534250155;
    if(bch_network === 'testnet') {
        if(!customUrl)
            client = new GrpcClient({testnet: true});
        minHeight = 1253801;
        minMtp = 1535262813;
    }

    var spinner = new Spinner('Getting Network Info.. %s');
    spinner.setSpinnerString('|/-\\');
    spinner.start();
    let bestHeight: number;
    let currentMtp: number;
    try {
        bestHeight = (await client.getBlockchainInfo()).getBestHeight();
        currentMtp = (await client.getBlockInfo(bestHeight)).getInfo()!.getMedianTime();
    } catch(e) {
        spinner.stop(true);
        console.log('Network error:', e.message)
        process.exit();
    }

    spinner.stop(true);

    console.log("------------NETWORK INFO------------")
    console.log("Current Height:", bestHeight!);
    console.log("Current MTP-11:", currentMtp!);
    console.log("------------------------------------")

    const time_mode = (await prompt([
        {
            type: 'list',
            name: 'time_mode',
            message: 'Time selection method:', 
            choices: [
                {
                    name: 'Use current best height',
                    value: 'best_block'
                },
                {
                    name: 'Enter block height (must be > '+minHeight+')',
                    value: 'height'
                },
                {
                    name: 'Enter MTP-11 unix timestamp (must be > '+minMtp+')',
                    value: 'mtp'
                },
                {
                    name: 'Use mempool state', 
                    value: 'mempool'
                }
            ]
        }
    ])).time_mode;

    let userHeight = -1;
    if(time_mode === 'mtp') {
        const userMtp = (await prompt([
            {
                type: 'input',
                name: 'mtp',
                message: 'Enter desired MTP-11:', 
                validate: function(t) { 
                    if(t < minMtp || t > currentMtp) return false;
                    return /^\d+$/.test(t);
                }
            }
        ])).mtp;

        const updateProgress = function(h: number) {
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0, 0);
            process.stdout.write('Searching for block with MTP.. '+h);
        }

        // download block info 
        clearScreen();
        for(let i = bestHeight!; bestHeight! > 0; i--) {
            let info = (await client.getBlockInfo(i)).getInfo()!;
            updateProgress(info!.getHeight());
            if(userMtp > info!.getMedianTime()) {
                userHeight = i + 1;
                break;
            }
        }
        clearScreen();
    } else if(time_mode === 'height') {
        userHeight = parseInt((await prompt([
            {
                type: 'input',
                name: 'height',
                message: 'Enter desired block height:',
                choices: [], 
                validate: function(h) { 
                    if(h < minHeight || h > bestHeight) return false;
                    return /^\d+$/.test(h);
                }
            }
        ])).height);
    } else if (time_mode === 'best_block') {
        userHeight = bestHeight!;
    }

    const answers = await prompt([
        {
            type: 'list',
            name: 'slpdb_host',
            message: 'Choose SLPDB host:',
            choices: slpdb_hosts[bch_network]
        },
        {
            type: 'input', 
            name: 'slp_tokenid', 
            message: 'Enter token ID:',
            validate: function(id) { return /^([A-Fa-f0-9]{2}){32,32}$/.test(id); }
        }
    ]);

    if(typeof userHeight !== 'number') throw Error('userHeight must be a number.');
 
    spinner = new Spinner('processing.. %s');
    spinner.setSpinnerString('|/-\\');
    spinner.start();
    const bals = <Map<string, Big>>await SlpdbQueries.GetAddressListFor(userHeight, answers.slp_tokenid, answers.slpdb_host);
    spinner.stop(true);

    const slp_total = Array.from(bals.values()).reduce((a, c) => a.plus(c), new Big(0));
    
    console.log("------------------------------------------------------")

    if(app_mode === 'slp_shareholder_list') {
        bals.forEach((v, k) => {
            if(v.gt(0))
                console.log(k + ",", v.toFixed());
        })
        console.log("------------------------------------------------------")
        console.log("Block Height:", userHeight);
        console.log("Address Count (includes 0 balances):", bals.size);
        console.log("Address Count (not including 0 balances):", Array.from(bals.values()).filter(v => v.gt(0)).length);
        console.log("Tokens Circulating:", slp_total.toFixed());
    }
    else if(app_mode === 'bch_dividend_list') {
        let bch_amount = (await prompt([{
            type: 'input', 
            name: 'bch_amount', 
            message: 'Enter BCH amount to distribute:',
            validate: function(id) { return /^\d+(\.\d{0,8})?$/.test(id); } // up to 8 decimal places
        }])).bch_amount;        

        bals.forEach((v, k) => {
            let d = v.div(slp_total).mul(bch_amount);
            if(d.gt(0.00000000))
                console.log(Bchaddr.toCashAddress(k) + ",", d.toFixed(8));
        });

        console.log("-----------------COPY/PASTE TO ELECTRON CASH-------------------\n")
        console.log("Block Height:", userHeight);
        console.log("Address Count (includes 0 balances):", bals.size);
        console.log("Address Count (not including 0 balances):", Array.from(bals.values()).filter(v => v.gt(0)).length);
        console.log("Receiver Count (not including 0 outputs):", Array.from(bals.values()).filter(v => v.round(8).gte(0.00000001)).length);
        console.log("Tokens Circulating:", slp_total.toFixed());
    }
    else if(app_mode === 'slp_airdrop_list') {
        let slp_divisibility = parseInt((await prompt([
            {
                type: 'input', 
                name: 'slp_divisibility',
                message: 'Airdrop token divisibility (must be between 0-9):',
                validate: function(id) { return /^(?:[0-9])$/.test(id); }
            }
        ])).slp_divisibility); 
        let regex = "^\\d+(\\.\\d{0," + slp_divisibility + "})?$";
        let re = new RegExp(regex);
        let slp_amount = (await prompt([
            {
                type: 'input', 
                name: 'slp_amount', 
                message: 'Enter airdrop amount:',
                validate: function(id) { return re.test(id); } // only 8 decimal places
            }
        ])).slp_amount;
        let counter = 0;
        let thresh = new Big(1).div(slp_divisibility);
        bals.forEach((v, k) => {
            let d = v.div(slp_total).mul(slp_amount);
            if(d.round(slp_divisibility).gte(thresh)) {
                console.log(k + ",", d.toFixed(slp_divisibility));
                counter+=1;
                if(counter % 19 === 0) {
                    console.log("------------------- SLP TXN OUTPUT LIMIT ---------------------");
                }
            }
        });

        console.log("---------- COPY/PASTE TO ELECTRON CASH SLP v3.4.15+ ----------\n")
        console.log("Block Height:", userHeight);
        console.log("Address Count (includes 0 balance):", bals.size);
        console.log("Address Count (not including 0 balances):", Array.from(bals.values()).filter(v => v.gt(0)).length);
        console.log("Receiver Count (not including 0 outputs):", counter);
        console.log("Tokens Circulating:", slp_total.toFixed());
    }    
})();


function clearScreen() {
    const blank = '\n'.repeat(process.stdout.rows!);
    console.log(blank);
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
}

