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

import { AccountManagement, signUpMethodID } from './AccountManagement.js';

let proofsEnabled = false;

describe('AccountManagement', () => {
  let deployerAccount: PrivateKey,
    zkAppAddress: PublicKey,
    zkappKey: PrivateKey,
    zkApp: AccountManagement,
    user1PrivateKey: PrivateKey,
    user2PrivateKey: PrivateKey,
    user1AsAccount: Account,
    user2AsAccount: Account,
    tree: MerkleTree;

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
    user1AsAccount = new Account({
      publicKey: user1PrivateKey.toPublicKey(),
      accountNumber: Field(1),
      balance: initialBalance,
      actionOrigin: UInt32.from(0),
    });
    user2AsAccount = new Account({
      publicKey: user2PrivateKey.toPublicKey(),
      accountNumber: Field(2),
      balance: initialBalance,
      actionOrigin: UInt32.from(0),
    });
    tree = new MerkleTree(21);
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

  async function processSignUpActions(
    actions: AccountShape[],
    tree: MerkleTree
  ) {
    for (let action of actions) {
      action.actionOrigin.assertEquals(signUpMethodID);
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

  function getActionsRange() {
    const startOfActionsRange = zkApp.startOfActionsRange.get();
    const endOfActionsRange = zkApp.endOfActionsRange.get();
    const actions2D = zkApp.reducer.getActions({
      fromActionHash: startOfActionsRange,
      endActionHash: endOfActionsRange,
    });
    const actions = actions2D.flat();
    return {
      actions: actions,
      startOfActionsRange: startOfActionsRange,
      endOfActionsRange: endOfActionsRange,
    };
  }

  function getAllActions() {
    const actions2D = zkApp.reducer.getActions({
      fromActionHash: zkApp.startOfAllActions.get(),
    });
    return actions2D.flat();
  }

  async function doSignUpTxn(userPrivateKey: PrivateKey) {
    const txn = await Mina.transaction(userPrivateKey, () => {
      zkApp.requestSignUp(userPrivateKey.toPublicKey());
    });
    await txn.prove();
    await txn.sign([userPrivateKey]).send();
  }

  async function doSetActionsRangeTxn() {
    const txn = await Mina.transaction(user1PrivateKey, () => {
      zkApp.setRangeOfActionsToBeProcessed();
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
    const accountsRoot = zkApp.accountsRoot.get();

    expect(startOfAllActions).toEqual(Reducer.initialActionsHash);
    expect(accountNumber).toEqual(Field(1));
    expect(numberOfPendingActions).toEqual(Field(0));
    expect(actionTurn).toEqual(Field(0));
    expect(startOfActionsRange).toEqual(Reducer.initialActionsHash);
    expect(endOfActionsRange).toEqual(Reducer.initialActionsHash);
    expect(accountsRoot).toEqual(Field(0));
  });

  it('emits proper sign-up request action when the `requestSignUp` method is executed', async () => {
    await localDeploy();

    await doSignUpTxn(user1PrivateKey);
    const actions = getAllActions();

    expect(actions.length).toEqual(1);
    expect(actions[0].publicKey).toEqual(user1PrivateKey.toPublicKey());
    expect(actions[0].accountNumber).toEqual(Field(1));
    expect(actions[0].balance).toEqual(initialBalance);
    expect(actions[0].actionOrigin).toEqual(UInt32.from(1));
  });

  it('emits 2 proper sign-up request actions when the `requestSignUp` method is executed 2 times with different accounts', async () => {
    await localDeploy();

    await doSignUpTxn(user1PrivateKey);
    await doSignUpTxn(user2PrivateKey);
    const actions = getAllActions();

    expect(actions.length).toEqual(2);
    expect(actions[0].publicKey).toEqual(user1PrivateKey.toPublicKey());
    expect(actions[0].accountNumber).toEqual(Field(1));
    expect(actions[0].balance).toEqual(initialBalance);
    expect(actions[0].actionOrigin).toEqual(UInt32.from(1));
    expect(actions[1].publicKey).toEqual(user2PrivateKey.toPublicKey());
    expect(actions[1].accountNumber).toEqual(Field(2));
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
    await doSignUpTxn(user1PrivateKey);
    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(initialBalance));
  });

  it('throws an error when `requestSignUp` is called with an account already requested to be signed-up', async () => {
    await localDeploy();

    await doSignUpTxn(user1PrivateKey);

    expect(async () => {
      await doSignUpTxn(user1PrivateKey);
    }).rejects.toThrowError('assert_equal: 1 != 0');
  });

  test(`number of pending actions and the action hashes for the range remain unchanged when 'setRangeOfActionsToBeProcessed'
        is executed when no actions have been emitted`, async () => {
    await localDeploy();

    const numberOfPendingActions = zkApp.numberOfPendingActions.get();
    const startOfActionsRange = zkApp.startOfActionsRange.get();
    const endOfActionsRange = zkApp.endOfActionsRange.get();

    await doSignUpTxn(user1PrivateKey);

    expect(numberOfPendingActions).toEqual(Field(0));
    expect(startOfActionsRange).toEqual(Reducer.initialActionsHash);
    expect(endOfActionsRange).toEqual(Reducer.initialActionsHash);
  });

  test(`number of pending actions and the action hash for the end of the range get updated properly when
        'setRangeOfActionsToBeProcessed' is executed when 2 actions have been emitted`, async () => {
    await localDeploy();
    await doSignUpTxn(user1PrivateKey);
    await doSignUpTxn(user2PrivateKey);
    await doSetActionsRangeTxn();

    const expectedNumberOfPendingActions = 2;
    const numberOfPendingActions = zkApp.numberOfPendingActions.get();
    const range = getActionsRange();

    expect(numberOfPendingActions).toEqual(
      Field(expectedNumberOfPendingActions)
    );
    expect(range.actions.length).toEqual(expectedNumberOfPendingActions);
  });

  test(`process 2 sign-up requests when executing 'processSignUpRequestAction'`, async () => {
    await localDeploy();

    await doSignUpTxn(user1PrivateKey);
    await doSignUpTxn(user2PrivateKey);
    await doSetActionsRangeTxn();

    user1AsAccount.actionOrigin = signUpMethodID;
    user2AsAccount.actionOrigin = signUpMethodID;

    let expectedTree = new MerkleTree(21);
    expectedTree.setLeaf(1n, user1AsAccount.hash());
    expectedTree.setLeaf(2n, user2AsAccount.hash());
    const expectedTreeRoot = expectedTree.getRoot();

    const range = getActionsRange();
    await processSignUpActions(range.actions, tree);

    expect(zkApp.accountsRoot.get()).toEqual(expectedTreeRoot);
    expect(zkApp.numberOfPendingActions.get()).toEqual(Field(0));
    expect(zkApp.actionTurn.get()).toEqual(Field(2));
  });

  test(`process the only sign-up request when executing 'processSignUpRequestAction',
        then emit a new one, set the range, and process it`, async () => {
    await localDeploy();

    await doSignUpTxn(user1PrivateKey);
    await doSetActionsRangeTxn();

    user1AsAccount.actionOrigin = signUpMethodID;

    let expectedTree = new MerkleTree(21);
    expectedTree.setLeaf(1n, user1AsAccount.hash());
    const expectedTreeRoot1 = expectedTree.getRoot();

    const range1 = getActionsRange();
    await processSignUpActions(range1.actions, tree);

    expect(zkApp.accountsRoot.get()).toEqual(expectedTreeRoot1);
    expect(zkApp.numberOfPendingActions.get()).toEqual(Field(0));
    expect(zkApp.actionTurn.get()).toEqual(Field(1));

    await doSignUpTxn(user2PrivateKey);
    await doSetActionsRangeTxn();

    user2AsAccount.actionOrigin = signUpMethodID;

    expectedTree.setLeaf(2n, user2AsAccount.hash());
    const expectedTreeRoot2 = expectedTree.getRoot();

    const range2 = getActionsRange();

    await processSignUpActions(range2.actions, tree);

    expect(zkApp.accountsRoot.get()).toEqual(expectedTreeRoot2);
    expect(zkApp.numberOfPendingActions.get()).toEqual(Field(0));
    expect(zkApp.actionTurn.get()).toEqual(Field(1));
  });

  test(`executing 'processSignUpRequestAction' by feeding it a witness from an account set in the merkle tree with an index
        not corresponding to the account number should throw an error`, async () => {
    await localDeploy();
    await doSignUpTxn(user1PrivateKey);
    await doSetActionsRangeTxn();

    tree.setLeaf(2n, user1AsAccount.hash());
    let aw = tree.getWitness(2n);
    let accountWitness = new AccountWitness(aw);

    expect(async () => {
      zkApp.processSignUpRequestAction(accountWitness);
    }).rejects.toThrowError('assert_equal: 2 != 1');
  });

  test(`Trying to process an action not emitted by requestSignUp, with processSignUpRequestAction
        throws the expected error`, async () => {
    await localDeploy();

    await doSignUpTxn(user1PrivateKey);
    await doSetActionsRangeTxn();

    const range1 = getActionsRange();
    await processSignUpActions(range1.actions, tree);

    const newUserPrivateKey = PrivateKey.random();
    const newUserPublicKey = newUserPrivateKey.toPublicKey();

    const txn = await Mina.transaction(deployerAccount, () => {
      AccountUpdate.fundNewAccount(deployerAccount);
      zkApp.releaseFunds(
        user1PrivateKey.toPublicKey(),
        newUserPublicKey,
        UInt64.from(1_000_000_000)
      );
    });
    await txn.prove();
    await txn.sign([user1PrivateKey]).send();

    await doSetActionsRangeTxn();
    const range2 = getActionsRange();

    let typedAction = new Account(range2.actions[0]);
    tree.setLeaf(
      range2.actions[0].accountNumber.toBigInt(),
      typedAction.hash()
    );
    let aw = tree.getWitness(range2.actions[0].accountNumber.toBigInt());
    let accountWitness = new AccountWitness(aw);

    expect(async () => {
      zkApp.processSignUpRequestAction(accountWitness);
    }).rejects.toThrowError('assert_equal: 2 != 1');
  });

  test(`when 'releaseFunds' is executed, it sends the right amount to the right address, and the balance from
        the sender gets updated accordingly`, async () => {
    await localDeploy();

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(0));

    await doSignUpTxn(user1PrivateKey);
    await doSignUpTxn(user2PrivateKey);
    await doSetActionsRangeTxn();

    const range = getActionsRange();
    await processSignUpActions(range.actions, tree);

    expect(Mina.getBalance(zkAppAddress)).toEqual(
      UInt64.from(initialBalance).mul(2)
    );

    const newUserPrivateKey = PrivateKey.random();
    const newUserPublicKey = newUserPrivateKey.toPublicKey();

    const txn1 = await Mina.transaction(deployerAccount, () => {
      AccountUpdate.fundNewAccount(deployerAccount);
      zkApp.releaseFunds(
        user1PrivateKey.toPublicKey(),
        newUserPublicKey,
        UInt64.from(1_000_000_000)
      );
    });
    await txn1.prove();
    await txn1.sign([user1PrivateKey]).send();

    const txn2 = await Mina.transaction(deployerAccount, () => {
      zkApp.releaseFunds(
        user2PrivateKey.toPublicKey(),
        newUserPublicKey,
        UInt64.from(2_500_000_000)
      );
    });
    await txn2.prove();
    await txn2.sign([user2PrivateKey]).send();

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

    await doSignUpTxn(user1PrivateKey);

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
