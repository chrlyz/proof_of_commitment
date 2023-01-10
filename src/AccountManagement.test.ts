import {
  isReady,
  shutdown,
  Mina,
  PrivateKey,
  PublicKey,
  AccountUpdate,
  Reducer,
  Field,
  MerkleTree,
} from 'snarkyjs';
import { Account } from './Account.js';

import { AccountManagement, AccountWitness } from './AccountManagement.js';

let proofsEnabled = true;

describe('AccountManagement', () => {
  let deployerAccount: PrivateKey,
    zkAppAddress: PublicKey,
    zkappKey: PrivateKey,
    zkApp: AccountManagement,
    user1Account: PrivateKey,
    user2Account: PrivateKey;

  beforeAll(async () => {
    await isReady;
    if (proofsEnabled) AccountManagement.compile();
  });

  beforeEach(() => {
    const Local = Mina.LocalBlockchain({ proofsEnabled });
    Mina.setActiveInstance(Local);
    deployerAccount = Local.testAccounts[0].privateKey;
    zkappKey = PrivateKey.random();
    zkAppAddress = zkappKey.toPublicKey();
    zkApp = new AccountManagement(zkAppAddress);
    user1Account = Local.testAccounts[1].privateKey;
    user2Account = Local.testAccounts[2].privateKey;
  });

  afterAll(() => {
    // `shutdown()` internally calls `process.exit()` which will exit the running Jest process early.
    // Specifying a timeout of 0 is a workaround to defer `shutdown()` until Jest is done running all tests.
    // This should be fixed with https://github.com/MinaProtocol/mina/issues/10943
    setTimeout(shutdown, 0);
  });

  async function localDeploy() {
    const txn = await Mina.transaction(deployerAccount, () => {
      AccountUpdate.fundNewAccount(deployerAccount);
      zkApp.deploy({ zkappKey });
    });
    await txn.prove();
    await txn.send();
  }

  it('successfully deploys the `AccountManagement` smart contract', async () => {
    await localDeploy();
    const startOfAllActions = zkApp.startOfAllActions.get();
    const accountNumber = zkApp.accountNumber.get();
    const numberOfPendingActions = zkApp.numberOfPendingActions.get();
    const actionTurn = zkApp.actionTurn.get();
    const startOfActionsRange = zkApp.startOfActionsRange.get();
    const endOfActionsRange = zkApp.endOfActionsRange.get();

    expect(startOfAllActions).toEqual(Reducer.initialActionsHash);
    expect(accountNumber).toEqual(Field(0));
    expect(numberOfPendingActions).toEqual(Field(0));
    expect(actionTurn).toEqual(Field(0));
    expect(startOfActionsRange).toEqual(Reducer.initialActionsHash);
    expect(endOfActionsRange).toEqual(Reducer.initialActionsHash);
  });

  it('emits proper sign-up request action when the `requestSignUp` method is executed', async () => {
    await localDeploy();

    const txn1 = await Mina.transaction(user1Account, () => {
      zkApp.requestSignUp(user1Account.toPublicKey());
    });
    await txn1.prove();
    await txn1.sign([user1Account]).send();

    const actions2D = zkApp.reducer.getActions({
      fromActionHash: zkApp.startOfAllActions.get(),
    });
    const actions = actions2D.flat();

    expect(actions.length).toEqual(1);
    expect(actions[0].accountNumber).toEqual(Field(0));
  });

  it('emits 2 proper sign-up request actions when the `requestSignUp` method is executed 2 times with different accounts', async () => {
    await localDeploy();

    const txn1 = await Mina.transaction(user1Account, () => {
      zkApp.requestSignUp(user1Account.toPublicKey());
    });
    await txn1.prove();
    await txn1.sign([user1Account]).send();

    const txn2 = await Mina.transaction(user2Account, () => {
      zkApp.requestSignUp(user2Account.toPublicKey());
    });
    await txn2.prove();
    await txn2.sign([user2Account]).send();

    const actions2D = zkApp.reducer.getActions({
      fromActionHash: zkApp.startOfAllActions.get(),
    });
    const actions = actions2D.flat();

    expect(actions.length).toEqual(2);
    expect(actions[0].accountNumber).toEqual(Field(0));
    expect(actions[1].accountNumber).toEqual(Field(1));
  });

  it('throws an error when a `requestSignUp` transaction is not signed by the account requesting to sign-up', async () => {
    await localDeploy();

    const txn1 = await Mina.transaction(user1Account, () => {
      zkApp.requestSignUp(user1Account.toPublicKey());
    });
    await txn1.prove();

    expect(async () => {
      await txn1.send();
    }).rejects.toThrowError('private key is missing');
  });

  it('throws an error when `requestSignUp` is called with an account already requested to be signed-up', async () => {
    await localDeploy();

    const txn1 = await Mina.transaction(user1Account, () => {
      zkApp.requestSignUp(user1Account.toPublicKey());
    });
    await txn1.prove();
    await txn1.sign([user1Account]).send();

    expect(async () => {
      await Mina.transaction(user1Account, () => {
        zkApp.requestSignUp(user1Account.toPublicKey());
      });
    }).rejects.toThrowError('assert_equal: 1 != 0');
  });

  test(`number of pending actions and the action hashes for the range remain unchanged when 'setRangeOfActionsToBeProcessed'
        is executed when no actions have been emitted`, async () => {
    await localDeploy();

    const numberOfPendingActions = zkApp.numberOfPendingActions.get();
    const startOfActionsRange = zkApp.startOfActionsRange.get();
    const endOfActionsRange = zkApp.endOfActionsRange.get();

    const txn = await Mina.transaction(user1Account, () => {
      zkApp.setRangeOfActionsToBeProcessed();
    });
    await txn.prove();
    await txn.send();

    expect(numberOfPendingActions).toEqual(Field(0));
    expect(startOfActionsRange).toEqual(Reducer.initialActionsHash);
    expect(endOfActionsRange).toEqual(Reducer.initialActionsHash);
  });

  test(`number of pending actions and the action hash for the end of the range get updated properly when
        'setRangeOfActionsToBeProcessed' is executed when 2 actions have been emitted`, async () => {
    await localDeploy();

    const txn1 = await Mina.transaction(user1Account, () => {
      zkApp.requestSignUp(user1Account.toPublicKey());
    });
    await txn1.prove();
    await txn1.sign([user1Account]).send();

    const txn2 = await Mina.transaction(user2Account, () => {
      zkApp.requestSignUp(user2Account.toPublicKey());
    });
    await txn2.prove();
    await txn2.sign([user2Account]).send();

    const txn3 = await Mina.transaction(user1Account, () => {
      zkApp.setRangeOfActionsToBeProcessed();
    });
    await txn3.prove();
    await txn3.send();

    const expectedNumberOfPendingActions = 2;
    const numberOfPendingActions = zkApp.numberOfPendingActions.get();
    const startOfActionsRange = zkApp.startOfActionsRange.get();
    const endOfActionsRange = zkApp.endOfActionsRange.get();

    const actions2D = zkApp.reducer.getActions({
      fromActionHash: startOfActionsRange,
      endActionHash: endOfActionsRange,
    });
    const actions = actions2D.flat();

    expect(numberOfPendingActions).toEqual(
      Field(expectedNumberOfPendingActions)
    );
    expect(actions.length).toEqual(expectedNumberOfPendingActions);
  });

  test(`process sign-up requests by adding the requesting accounts to the merkle tree when executing 'processSignUpRequestAction'`, async () => {
    await localDeploy();

    const txn1 = await Mina.transaction(user1Account, () => {
      zkApp.requestSignUp(user1Account.toPublicKey());
    });
    await txn1.prove();
    await txn1.sign([user1Account]).send();

    const txn2 = await Mina.transaction(user2Account, () => {
      zkApp.requestSignUp(user2Account.toPublicKey());
    });
    await txn2.prove();
    await txn2.sign([user2Account]).send();

    const txn3 = await Mina.transaction(deployerAccount, () => {
      zkApp.setRangeOfActionsToBeProcessed();
    });
    await txn3.prove();
    await txn3.send();

    const user1AccountAsAction = new Account({
      publicKey: user1Account.toPublicKey(),
      accountNumber: Field(0),
    });
    const user2AccountAsAction = new Account({
      publicKey: user2Account.toPublicKey(),
      accountNumber: Field(1),
    });

    let expectedTree = new MerkleTree(21);
    expectedTree.setLeaf(0n, user1AccountAsAction.hash());
    expectedTree.setLeaf(1n, user2AccountAsAction.hash());
    const expectedTreeRoot = expectedTree.getRoot();

    const startOfActionsRange = zkApp.startOfActionsRange.get();
    const endOfActionsRange = zkApp.endOfActionsRange.get();

    const actions2D = zkApp.reducer.getActions({
      fromActionHash: startOfActionsRange,
      endActionHash: endOfActionsRange,
    });
    const actions = actions2D.flat();

    let tree = new MerkleTree(21);

    async function processActions(
      actions: { publicKey: PublicKey; accountNumber: Field }[]
    ) {
      for (let action of actions) {
        let typedAction = new Account({
          publicKey: action.publicKey,
          accountNumber: action.accountNumber,
        });
        tree.setLeaf(action.accountNumber.toBigInt(), typedAction.hash());
        let aw = tree.getWitness(action.accountNumber.toBigInt());
        let accountWitness = new AccountWitness(aw);

        const txn = await Mina.transaction(deployerAccount, () => {
          zkApp.processSignUpRequestAction(accountWitness);
        });
        await txn.prove();
        await txn.send();
      }
    }

    await processActions(actions);

    expect(zkApp.accountsRoot.get()).toEqual(expectedTreeRoot);
    expect(zkApp.numberOfPendingActions.get()).toEqual(Field(0));
    expect(zkApp.actionTurn.get()).toEqual(Field(2));
  });
});
