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
  UInt64,
  UInt32,
} from 'snarkyjs';

import {
  Account,
  AccountShape,
  AccountWitness,
  initialBalance,
} from './Account.js';

import { AccountManagement } from './AccountManagement.js';

let proofsEnabled = false;

describe('AccountManagement', () => {
  let deployerAccount: PrivateKey,
    zkAppAddress: PublicKey,
    zkappKey: PrivateKey,
    zkApp: AccountManagement,
    user1PrivateKey: PrivateKey,
    user2PrivateKey: PrivateKey;

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
    user1PrivateKey = Local.testAccounts[1].privateKey;
    user2PrivateKey = Local.testAccounts[2].privateKey;
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

  async function processActions(actions: AccountShape[], tree: MerkleTree) {
    for (let action of actions) {
      let typedAction = new Account(action);
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

  it('successfully deploys the `AccountManagement` smart contract', async () => {
    await localDeploy();
    const startOfAllActions = zkApp.startOfAllActions.get();
    const accountNumber = zkApp.accountNumber.get();
    const numberOfPendingActions = zkApp.numberOfPendingActions.get();
    const actionTurn = zkApp.actionTurn.get();
    const startOfActionsRange = zkApp.startOfActionsRange.get();
    const endOfActionsRange = zkApp.endOfActionsRange.get();
    const accountsRoot = zkApp.accountsRoot.get();

    expect(startOfAllActions).toEqual(Reducer.initialActionsHash);
    expect(accountNumber).toEqual(Field(0));
    expect(numberOfPendingActions).toEqual(Field(0));
    expect(actionTurn).toEqual(Field(0));
    expect(startOfActionsRange).toEqual(Reducer.initialActionsHash);
    expect(endOfActionsRange).toEqual(Reducer.initialActionsHash);
    expect(accountsRoot).toEqual(Field(0));
  });

  it('emits proper sign-up request action when the `requestSignUp` method is executed', async () => {
    await localDeploy();

    const txn1 = await Mina.transaction(user1PrivateKey, () => {
      zkApp.requestSignUp(user1PrivateKey.toPublicKey());
    });
    await txn1.prove();
    await txn1.sign([user1PrivateKey]).send();

    const actions2D = zkApp.reducer.getActions({
      fromActionHash: zkApp.startOfAllActions.get(),
    });
    const actions = actions2D.flat();

    expect(actions.length).toEqual(1);
    expect(actions[0].publicKey).toEqual(user1PrivateKey.toPublicKey());
    expect(actions[0].accountNumber).toEqual(Field(0));
    expect(actions[0].balance).toEqual(initialBalance);
    expect(actions[0].actionOrigin).toEqual(UInt32.from(1));
  });

  it('emits 2 proper sign-up request actions when the `requestSignUp` method is executed 2 times with different accounts', async () => {
    await localDeploy();

    const txn1 = await Mina.transaction(user1PrivateKey, () => {
      zkApp.requestSignUp(user1PrivateKey.toPublicKey());
    });
    await txn1.prove();
    await txn1.sign([user1PrivateKey]).send();

    const txn2 = await Mina.transaction(user2PrivateKey, () => {
      zkApp.requestSignUp(user2PrivateKey.toPublicKey());
    });
    await txn2.prove();
    await txn2.sign([user2PrivateKey]).send();

    const actions2D = zkApp.reducer.getActions({
      fromActionHash: zkApp.startOfAllActions.get(),
    });
    const actions = actions2D.flat();

    expect(actions.length).toEqual(2);
    expect(actions[0].publicKey).toEqual(user1PrivateKey.toPublicKey());
    expect(actions[0].accountNumber).toEqual(Field(0));
    expect(actions[0].balance).toEqual(initialBalance);
    expect(actions[0].actionOrigin).toEqual(UInt32.from(1));
    expect(actions[1].publicKey).toEqual(user2PrivateKey.toPublicKey());
    expect(actions[1].accountNumber).toEqual(Field(1));
    expect(actions[1].balance).toEqual(initialBalance);
    expect(actions[1].actionOrigin).toEqual(UInt32.from(1));
  });

  it('throws an error when a `requestSignUp` transaction is not signed by the account requesting to sign-up', async () => {
    await localDeploy();

    const txn1 = await Mina.transaction(user1PrivateKey, () => {
      zkApp.requestSignUp(user1PrivateKey.toPublicKey());
    });
    await txn1.prove();

    expect(async () => {
      await txn1.send();
    }).rejects.toThrowError('private key is missing');
  });

  it('sends 5 MINA to the contract when a `requestSignUp` transaction is sent', async () => {
    await localDeploy();

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(0));

    const txn1 = await Mina.transaction(user1PrivateKey, () => {
      zkApp.requestSignUp(user1PrivateKey.toPublicKey());
    });
    await txn1.prove();
    await txn1.sign([user1PrivateKey]).send();

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(initialBalance));
  });

  it('throws an error when `requestSignUp` is called with an account already requested to be signed-up', async () => {
    await localDeploy();

    const txn1 = await Mina.transaction(user1PrivateKey, () => {
      zkApp.requestSignUp(user1PrivateKey.toPublicKey());
    });
    await txn1.prove();
    await txn1.sign([user1PrivateKey]).send();

    expect(async () => {
      await Mina.transaction(user1PrivateKey, () => {
        zkApp.requestSignUp(user1PrivateKey.toPublicKey());
      });
    }).rejects.toThrowError('assert_equal: 1 != 0');
  });

  test(`number of pending actions and the action hashes for the range remain unchanged when 'setRangeOfActionsToBeProcessed'
        is executed when no actions have been emitted`, async () => {
    await localDeploy();

    const numberOfPendingActions = zkApp.numberOfPendingActions.get();
    const startOfActionsRange = zkApp.startOfActionsRange.get();
    const endOfActionsRange = zkApp.endOfActionsRange.get();

    const txn = await Mina.transaction(user1PrivateKey, () => {
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

    const txn1 = await Mina.transaction(user1PrivateKey, () => {
      zkApp.requestSignUp(user1PrivateKey.toPublicKey());
    });
    await txn1.prove();
    await txn1.sign([user1PrivateKey]).send();

    const txn2 = await Mina.transaction(user2PrivateKey, () => {
      zkApp.requestSignUp(user2PrivateKey.toPublicKey());
    });
    await txn2.prove();
    await txn2.sign([user2PrivateKey]).send();

    const txn3 = await Mina.transaction(user1PrivateKey, () => {
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

  test(`process 2 sign-up requests when executing 'processSignUpRequestAction'`, async () => {
    await localDeploy();

    const txn1 = await Mina.transaction(user1PrivateKey, () => {
      zkApp.requestSignUp(user1PrivateKey.toPublicKey());
    });
    await txn1.prove();
    await txn1.sign([user1PrivateKey]).send();

    const txn2 = await Mina.transaction(user2PrivateKey, () => {
      zkApp.requestSignUp(user2PrivateKey.toPublicKey());
    });
    await txn2.prove();
    await txn2.sign([user2PrivateKey]).send();

    const txn3 = await Mina.transaction(deployerAccount, () => {
      zkApp.setRangeOfActionsToBeProcessed();
    });
    await txn3.prove();
    await txn3.send();

    const user1AsAccount = new Account({
      publicKey: user1PrivateKey.toPublicKey(),
      accountNumber: Field(0),
      balance: initialBalance,
      actionOrigin: UInt32.from(1),
    });
    const user2AsAccount = new Account({
      publicKey: user2PrivateKey.toPublicKey(),
      accountNumber: Field(1),
      balance: initialBalance,
      actionOrigin: UInt32.from(1),
    });

    let expectedTree = new MerkleTree(21);
    expectedTree.setLeaf(0n, user1AsAccount.hash());
    expectedTree.setLeaf(1n, user2AsAccount.hash());
    const expectedTreeRoot = expectedTree.getRoot();

    const startOfActionsRange = zkApp.startOfActionsRange.get();
    const endOfActionsRange = zkApp.endOfActionsRange.get();

    const actions2D = zkApp.reducer.getActions({
      fromActionHash: startOfActionsRange,
      endActionHash: endOfActionsRange,
    });
    const actions = actions2D.flat();

    let tree = new MerkleTree(21);

    await processActions(actions, tree);

    expect(zkApp.accountsRoot.get()).toEqual(expectedTreeRoot);
    expect(zkApp.numberOfPendingActions.get()).toEqual(Field(0));
    expect(zkApp.actionTurn.get()).toEqual(Field(2));
  });

  test(`process the only sign-up request when executing 'processSignUpRequestAction',
        then emit a new one, set the range, and process it`, async () => {
    await localDeploy();

    const txn1 = await Mina.transaction(user1PrivateKey, () => {
      zkApp.requestSignUp(user1PrivateKey.toPublicKey());
    });
    await txn1.prove();
    await txn1.sign([user1PrivateKey]).send();

    const txn2 = await Mina.transaction(deployerAccount, () => {
      zkApp.setRangeOfActionsToBeProcessed();
    });
    await txn2.prove();
    await txn2.send();

    const user1AsAccount = new Account({
      publicKey: user1PrivateKey.toPublicKey(),
      accountNumber: Field(0),
      balance: initialBalance,
      actionOrigin: UInt32.from(1),
    });

    let expectedTree = new MerkleTree(21);
    expectedTree.setLeaf(0n, user1AsAccount.hash());
    const expectedTreeRoot1 = expectedTree.getRoot();

    const startOfActionsRange1 = zkApp.startOfActionsRange.get();
    const endOfActionsRange1 = zkApp.endOfActionsRange.get();

    const actions2D1 = zkApp.reducer.getActions({
      fromActionHash: startOfActionsRange1,
      endActionHash: endOfActionsRange1,
    });
    const actions1 = actions2D1.flat();

    let tree = new MerkleTree(21);

    await processActions(actions1, tree);

    expect(zkApp.accountsRoot.get()).toEqual(expectedTreeRoot1);
    expect(zkApp.numberOfPendingActions.get()).toEqual(Field(0));
    expect(zkApp.actionTurn.get()).toEqual(Field(1));

    const txn3 = await Mina.transaction(user2PrivateKey, () => {
      zkApp.requestSignUp(user2PrivateKey.toPublicKey());
    });
    await txn3.prove();
    await txn3.sign([user2PrivateKey]).send();

    const txn4 = await Mina.transaction(deployerAccount, () => {
      zkApp.setRangeOfActionsToBeProcessed();
    });
    await txn4.prove();
    await txn4.send();

    const user2AsAccount = new Account({
      publicKey: user2PrivateKey.toPublicKey(),
      accountNumber: Field(1),
      balance: initialBalance,
      actionOrigin: UInt32.from(1),
    });

    expectedTree.setLeaf(1n, user2AsAccount.hash());
    const expectedTreeRoot2 = expectedTree.getRoot();

    const startOfActionsRange2 = zkApp.startOfActionsRange.get();
    const endOfActionsRange2 = zkApp.endOfActionsRange.get();

    const actions2D2 = zkApp.reducer.getActions({
      fromActionHash: startOfActionsRange2,
      endActionHash: endOfActionsRange2,
    });
    const actions2 = actions2D2.flat();

    await processActions(actions2, tree);

    expect(zkApp.accountsRoot.get()).toEqual(expectedTreeRoot2);
    expect(zkApp.numberOfPendingActions.get()).toEqual(Field(0));
    expect(zkApp.actionTurn.get()).toEqual(Field(1));
  });

  test(`executing 'processSignUpRequestAction' by feeding it a witness from an account set in the merkle tree with an index
        not corresponding to the account number should throw an error`, async () => {
    await localDeploy();

    const txn1 = await Mina.transaction(user1PrivateKey, () => {
      zkApp.requestSignUp(user1PrivateKey.toPublicKey());
    });
    await txn1.prove();
    await txn1.sign([user1PrivateKey]).send();

    const txn2 = await Mina.transaction(deployerAccount, () => {
      zkApp.setRangeOfActionsToBeProcessed();
    });
    await txn2.prove();
    await txn2.send();

    const user1AsAccount = new Account({
      publicKey: user1PrivateKey.toPublicKey(),
      accountNumber: Field(0),
      balance: initialBalance,
      actionOrigin: UInt32.from(0),
    });

    let tree = new MerkleTree(21);
    tree.setLeaf(1n, user1AsAccount.hash());
    let aw = tree.getWitness(1n);
    let accountWitness = new AccountWitness(aw);

    expect(async () => {
      zkApp.processSignUpRequestAction(accountWitness);
    }).rejects.toThrowError('assert_equal: 1 != 0');
  });

  test(`Trying to process an action not emitted by requestSignUp, with processSignUpRequestAction
        throws the expected error`, async () => {
    await localDeploy();

    const txn1 = await Mina.transaction(user1PrivateKey, () => {
      zkApp.requestSignUp(user1PrivateKey.toPublicKey());
    });
    await txn1.prove();
    await txn1.sign([user1PrivateKey]).send();

    const txn2 = await Mina.transaction(deployerAccount, () => {
      zkApp.setRangeOfActionsToBeProcessed();
    });
    await txn2.prove();
    await txn2.send();

    let startOfActionsRange = zkApp.startOfActionsRange.get();
    let endOfActionsRange = zkApp.endOfActionsRange.get();

    let actions2D = zkApp.reducer.getActions({
      fromActionHash: startOfActionsRange,
      endActionHash: endOfActionsRange,
    });
    let actions = actions2D.flat();

    let tree = new MerkleTree(21);

    await processActions(actions, tree);

    const newUserPrivateKey = PrivateKey.random();
    const newUserPublicKey = newUserPrivateKey.toPublicKey();

    const txn3 = await Mina.transaction(deployerAccount, () => {
      AccountUpdate.fundNewAccount(deployerAccount);
      zkApp.releaseFunds(
        user1PrivateKey.toPublicKey(),
        newUserPublicKey,
        UInt64.from(1_000_000_000)
      );
    });
    await txn3.prove();
    await txn3.sign([user1PrivateKey]).send();

    const txn4 = await Mina.transaction(deployerAccount, () => {
      zkApp.setRangeOfActionsToBeProcessed();
    });
    await txn4.prove();
    await txn4.send();

    startOfActionsRange = zkApp.startOfActionsRange.get();
    endOfActionsRange = zkApp.endOfActionsRange.get();

    actions2D = zkApp.reducer.getActions({
      fromActionHash: startOfActionsRange,
      endActionHash: endOfActionsRange,
    });
    actions = actions2D.flat();

    let typedAction = new Account(actions[0]);
    tree.setLeaf(actions[0].accountNumber.toBigInt(), typedAction.hash());
    let aw = tree.getWitness(actions[0].accountNumber.toBigInt());
    let accountWitness = new AccountWitness(aw);

    expect(async () => {
      zkApp.processSignUpRequestAction(accountWitness);
    }).rejects.toThrowError('assert_equal: 2 != 1');
  });

  test(`when 'releaseFunds' is executed, it sends the right amount to the right address, and the balance from
        the sender gets updated accordingly`, async () => {
    await localDeploy();

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(0));

    const txn1 = await Mina.transaction(user1PrivateKey, () => {
      zkApp.requestSignUp(user1PrivateKey.toPublicKey());
    });
    await txn1.prove();
    await txn1.sign([user1PrivateKey]).send();

    const txn2 = await Mina.transaction(user2PrivateKey, () => {
      zkApp.requestSignUp(user2PrivateKey.toPublicKey());
    });
    await txn2.prove();
    await txn2.sign([user2PrivateKey]).send();

    const txn3 = await Mina.transaction(deployerAccount, () => {
      zkApp.setRangeOfActionsToBeProcessed();
    });
    await txn3.prove();
    await txn3.send();

    const startOfActionsRange = zkApp.startOfActionsRange.get();
    const endOfActionsRange = zkApp.endOfActionsRange.get();

    const actions2D = zkApp.reducer.getActions({
      fromActionHash: startOfActionsRange,
      endActionHash: endOfActionsRange,
    });
    const actions = actions2D.flat();

    let tree = new MerkleTree(21);

    await processActions(actions, tree);

    expect(Mina.getBalance(zkAppAddress)).toEqual(
      UInt64.from(initialBalance).mul(2)
    );

    const newUserPrivateKey = PrivateKey.random();
    const newUserPublicKey = newUserPrivateKey.toPublicKey();

    const txn4 = await Mina.transaction(deployerAccount, () => {
      AccountUpdate.fundNewAccount(deployerAccount);
      zkApp.releaseFunds(
        user1PrivateKey.toPublicKey(),
        newUserPublicKey,
        UInt64.from(1_000_000_000)
      );
    });
    await txn4.prove();
    await txn4.sign([user1PrivateKey]).send();

    const txn5 = await Mina.transaction(deployerAccount, () => {
      zkApp.releaseFunds(
        user2PrivateKey.toPublicKey(),
        newUserPublicKey,
        UInt64.from(2_500_000_000)
      );
    });
    await txn5.prove();
    await txn5.sign([user2PrivateKey]).send();

    expect(Mina.getBalance(zkAppAddress)).toEqual(
      UInt64.from(initialBalance).mul(2).sub(3_500_000_000)
    );
    expect(Mina.getBalance(newUserPublicKey)).toEqual(
      UInt64.from(3_500_000_000)
    );
  });

  test(`contract admin can't send funds from the contract by just signing transactions`, async () => {
    await localDeploy();

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(0));

    const txn1 = await Mina.transaction(user1PrivateKey, () => {
      zkApp.requestSignUp(user1PrivateKey.toPublicKey());
    });
    await txn1.prove();
    await txn1.sign([user1PrivateKey]).send();

    const newUserPrivateKey = PrivateKey.random();
    const newUserPublicKey = newUserPrivateKey.toPublicKey();

    const txn2 = await Mina.transaction(deployerAccount, () => {
      AccountUpdate.fundNewAccount(deployerAccount);
      AccountUpdate.create(deployerAccount.toPublicKey()).send({
        to: newUserPublicKey,
        amount: UInt64.from(1),
      });
    });
    await txn2.prove();
    await txn2.send();

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(initialBalance));
    expect(Mina.getBalance(newUserPublicKey)).toEqual(UInt64.from(1));

    /* Using zkApp.send fails silently without doing nothing, so we don't
     * expect any errors to be thrown by this, we just check later that it
     * actually did nothing.
     */
    const txn3 = await Mina.transaction(zkappKey, () => {
      zkApp.send({ to: newUserPublicKey, amount: UInt64.from(1_000_000_000) });
    });
    await txn3.prove();
    await txn3.sign([zkappKey]).send();

    // Second attempt to send funds using AccountUpdate
    const txn4 = await Mina.transaction(zkappKey, () => {
      AccountUpdate.create(zkAppAddress).send({
        to: newUserPublicKey,
        amount: UInt64.from(1_000_000_000),
      });
    });
    await txn4.prove();
    txn4.sign([zkappKey]);

    expect(async () => {
      await txn4.send();
    }).rejects.toThrowError('Update_not_permitted_balance');

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(initialBalance));
    expect(Mina.getBalance(newUserPublicKey)).toEqual(UInt64.from(1));
  });
});
