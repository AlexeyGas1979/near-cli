const {
    transactions,
    DEFAULT_FUNCTION_CALL_GAS,
    utils,
} = require('near-api-js');
const exitOnError = require('../utils/exit-on-error');
const connect = require('../utils/connect');
const createDevAccountIfNeeded = require('../utils/create-dev-account');
const { readFileSync } = require('fs');

const { PROJECT_KEY_DIR } = require('../middleware/key-store');

const eventtracking = require('../utils/eventtracking');
const inspectResponse = require('../utils/inspect-response');


module.exports = {
    command: 'dev-deploy [wasmFile] [initFunction] [initArgs] [initGas] [initDeposit] [initialBalance] [force]',
    desc: 'deploy your smart contract using temporary account (TestNet only)',
    builder: (yargs) => yargs
        .option('wasmFile', {
            desc: 'Path to wasm file to deploy',
            type: 'string',
            default: './out/main.wasm'
        })
        .option('initFunction', {
            desc: 'Initialization method',
            type: 'string',
        })
        .option('initArgs', {
            desc: 'Initialization arguments',
        })
        .option('initGas', {
            desc: 'Gas for initialization call',
            type: 'number',
            default: DEFAULT_FUNCTION_CALL_GAS
        })
        .option('initDeposit', {
            desc: 'Deposit in Ⓝ to send for initialization call',
            type: 'string',
            default: '0'
        })
        .option('initialBalance', {
            desc: 'Number of tokens to transfer to newly created account',
            type: 'string',
            default: '100'
        })
        .option('init', {
            desc: 'Create new account for deploy (even if there is one already available)',
            type: 'boolean',
            default: false
        })
        .option('projectKeyDirectory', {
            desc: 'Specify a directory which will be used for generating the keys other than the default one',
            type: 'string',
            default: PROJECT_KEY_DIR
        })
        .alias({
            'init': ['force', 'f'],
        }),
    handler: exitOnError(devDeploy)
};

async function devDeploy(options) {
    if (options.networkId === 'mainnet') {
        throw Error('MainNet doesn\'t support dev-deploy. Use export NEAR_ENV=testnet to switch to TestNet');
    }
    await eventtracking.askForConsentIfNeeded(options);
    const { nodeUrl, helperUrl, masterAccount, wasmFile } = options;
    if (!helperUrl && !masterAccount) {
        throw new Error('Cannot create account as neither helperUrl nor masterAccount is specified in config for current NODE_ENV (see src/config.js)');
    }
    const near = await connect(options);
    const accountId = await createDevAccountIfNeeded({ ...options, near });
    const account = await near.account(accountId);
    let prevState = await account.state();
    let prevCodeHash = prevState.code_hash;

    console.log(
        `Starting deployment. Account id: ${accountId}, node: ${nodeUrl}, helper: ${helperUrl}, file: ${wasmFile}`);

    // Deploy with init function and args
    const actions = [transactions.deployContract(readFileSync(options.wasmFile))];

    if (options.initArgs && !options.initFunction) {
        options.initFunction = 'new';
    }

    if (options.initFunction) {
        if (!options.initArgs) {
            await eventtracking.track(eventtracking.EVENT_ID_DEPLOY_END, { success: false, error: 'Must add initialization arguments' }, options);
            throw Error('Must add initialization arguments.\nExample: near dev-deploy --initFunction "new" --initArgs \'{"key": "value"}\'');
        }
        actions.push(transactions.functionCall(
            options.initFunction,
            Buffer.from(options.initArgs),
            options.initGas,
            utils.format.parseNearAmount(options.initDeposit)),
        );
    }

    const result = await account.signAndSendTransaction({
        receiverId: accountId,
        actions: actions
    });
    inspectResponse.prettyPrintResponse(result, options);
    let state = await account.state();
    let codeHash = state.code_hash;
    await eventtracking.track(eventtracking.EVENT_ID_DEPLOY_END, { success: true, code_hash: codeHash, is_same_contract: prevCodeHash === codeHash, contract_id: options.accountId }, options);
    eventtracking.trackDeployedContract();
    console.log(`Done deploying ${options.initFunction ? 'and initializing' : 'to'} ${accountId}`);
}
