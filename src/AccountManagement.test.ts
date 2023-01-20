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

import { Account, AccountWitness, initialBalance } from './Account.js';

import {
  AccountManagement,
  signUpMethodID,
  root,
  releaseFundsRequestMethodID,
} from './AccountManagement.js';

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
    /* `shutdown()` internally calls `process.exit()` which will exit the
     * running Jest process early. Specifying a timeout of 0 is a workaround
     * to defer `shutdown()` until Jest is done running all tests.
     * This should be fixed with:
     * https://github.com/MinaProtocol/mina/issues/10943
     */
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

  async function processSignUpAction(action: Account, tree: MerkleTree) {
    action.actionOrigin.assertEquals(signUpMethodID);
    action.accountNumber = zkApp.accountNumber.get();
    tree.setLeaf(action.accountNumber.toBigInt(), action.hash());
    let aw = tree.getWitness(action.accountNumber.toBigInt());
    let accountWitness = new AccountWitness(aw);

    const txn = await Mina.transaction(deployerAccount, () => {
      zkApp.processSignUpRequestAction(accountWitness);
    });
    await txn.prove();
    await txn.send();
    return { actionWithAccountNumber: action, accountWitness: accountWitness };
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

  async function doReleaseFundsRequestTxn(
    releaser: PrivateKey,
    releaserAccount: Account,
    accountWitness: AccountWitness,
    receiver: PublicKey,
    amount: number
  ) {
    const txn = await Mina.transaction(releaser, () => {
      zkApp.releaseFundsRequest(
        releaserAccount,
        accountWitness,
        receiver,
        UInt64.from(amount)
      );
    });
    await txn.prove();
    await txn.sign([releaser]).send();
  }

  async function createNewMinaAccount(sponsor: PrivateKey, amount: number) {
    const newUserPrivateKey = PrivateKey.random();

    const txn = await Mina.transaction(sponsor, () => {
      AccountUpdate.fundNewAccount(sponsor);
      AccountUpdate.create(sponsor.toPublicKey()).send({
        to: newUserPrivateKey.toPublicKey(),
        amount,
      });
    });
    await txn.prove();
    await txn.sign([sponsor]).send();
    return newUserPrivateKey;
  }

  it(`successfully deploys the AccountManagement smart contract`, async () => {
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
    expect(accountsRoot).toEqual(root);
  });

  it(`emits proper sign-up request action when the requestSignUp method
  is executed`, async () => {
    await localDeploy();

    await doSignUpTxn(user1PrivateKey);
    const actions = getAllActions();

    expect(actions.length).toEqual(1);
    expect(actions[0].publicKey).toEqual(user1PrivateKey.toPublicKey());
    expect(actions[0].accountNumber).toEqual(Field(0));
    expect(actions[0].balance).toEqual(initialBalance);
    expect(actions[0].actionOrigin).toEqual(UInt32.from(1));
  });

  it(`emits 2 proper sign-up request actions when the requestSignUp method is
  executed 2 times with different accounts`, async () => {
    await localDeploy();

    await doSignUpTxn(user1PrivateKey);
    await doSignUpTxn(user2PrivateKey);
    const actions = getAllActions();

    expect(actions.length).toEqual(2);
    expect(actions[0].publicKey).toEqual(user1PrivateKey.toPublicKey());
    expect(actions[0].accountNumber).toEqual(Field(0));
    expect(actions[0].balance).toEqual(initialBalance);
    expect(actions[0].actionOrigin).toEqual(UInt32.from(1));
    expect(actions[1].publicKey).toEqual(user2PrivateKey.toPublicKey());
    expect(actions[1].accountNumber).toEqual(Field(0));
    expect(actions[1].balance).toEqual(initialBalance);
    expect(actions[1].actionOrigin).toEqual(UInt32.from(1));
  });

  it(`throws an error when a requestSignUp transaction is not signed by the
  account requesting to sign-up`, async () => {
    await localDeploy();

    const txn = await Mina.transaction(user1PrivateKey, () => {
      zkApp.requestSignUp(user1PrivateKey.toPublicKey());
    });
    await txn.prove();

    expect(async () => {
      await txn.send();
    }).rejects.toThrowError('private key is missing');
  });

  it('sends 5 MINA to the contract when a `requestSignUp` transaction is sent', async () => {
    await localDeploy();

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(0));
    await doSignUpTxn(user1PrivateKey);
    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(initialBalance));
  });

  it(`throws an error when requestSignUp is called with an account already
  requested to be signed-up`, async () => {
    await localDeploy();

    await doSignUpTxn(user1PrivateKey);

    expect(async () => {
      await doSignUpTxn(user1PrivateKey);
    }).rejects.toThrowError('assert_equal: 1 != 0');
  });

  test(`number of pending actions and the action hashes for the range remain
  unchanged when setRangeOfActionsToBeProcessed is executed when no actions
  have been emitted`, async () => {
    await localDeploy();

    const numberOfPendingActions = zkApp.numberOfPendingActions.get();
    const startOfActionsRange = zkApp.startOfActionsRange.get();
    const endOfActionsRange = zkApp.endOfActionsRange.get();

    await doSignUpTxn(user1PrivateKey);

    expect(numberOfPendingActions).toEqual(Field(0));
    expect(startOfActionsRange).toEqual(Reducer.initialActionsHash);
    expect(endOfActionsRange).toEqual(Reducer.initialActionsHash);
  });

  test(`number of pending actions and the action hash for the end of the range
  get updated properly when setRangeOfActionsToBeProcessed is executed when
  2 actions have been emitted`, async () => {
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

  test(`process 2 sign-up requests when executing processSignUpRequestAction`, async () => {
    await localDeploy();

    await doSignUpTxn(user1PrivateKey);
    await doSignUpTxn(user2PrivateKey);
    await doSetActionsRangeTxn();

    const range = getActionsRange();

    for (let action of range.actions) {
      await processSignUpAction(action, tree);
    }

    user1AsAccount.actionOrigin = signUpMethodID;
    user2AsAccount.actionOrigin = signUpMethodID;

    let expectedTree = new MerkleTree(21);
    expectedTree.setLeaf(1n, user1AsAccount.hash());
    expectedTree.setLeaf(2n, user2AsAccount.hash());
    const expectedTreeRoot = expectedTree.getRoot();

    expect(zkApp.accountsRoot.get()).toEqual(expectedTreeRoot);
    expect(zkApp.numberOfPendingActions.get()).toEqual(Field(0));
    expect(zkApp.actionTurn.get()).toEqual(Field(2));
  });

  test(`process the sign-up request when executing processSignUpRequestAction,
  then a new one is emitted, the range is set, and the new one is processed by
  processSignUpRequestAction again`, async () => {
    await localDeploy();

    await doSignUpTxn(user1PrivateKey);
    await doSetActionsRangeTxn();

    user1AsAccount.actionOrigin = signUpMethodID;

    let expectedTree = new MerkleTree(21);
    expectedTree.setLeaf(1n, user1AsAccount.hash());
    const expectedTreeRoot1 = expectedTree.getRoot();

    const range1 = getActionsRange();
    for (let action of range1.actions) {
      await processSignUpAction(action, tree);
    }

    expect(zkApp.accountsRoot.get()).toEqual(expectedTreeRoot1);
    expect(zkApp.numberOfPendingActions.get()).toEqual(Field(0));
    expect(zkApp.actionTurn.get()).toEqual(Field(1));

    await doSignUpTxn(user2PrivateKey);
    await doSetActionsRangeTxn();

    user2AsAccount.actionOrigin = signUpMethodID;

    expectedTree.setLeaf(2n, user2AsAccount.hash());
    const expectedTreeRoot2 = expectedTree.getRoot();

    const range2 = getActionsRange();
    for (let action of range2.actions) {
      await processSignUpAction(action, tree);
    }

    expect(zkApp.accountsRoot.get()).toEqual(expectedTreeRoot2);
    expect(zkApp.numberOfPendingActions.get()).toEqual(Field(0));
    expect(zkApp.actionTurn.get()).toEqual(Field(1));
  });

  test(`executing processSignUpRequestAction by feeding it a witness from an
  account set in the merkle tree with an index not corresponding to the account
  number should throw an error`, async () => {
    await localDeploy();
    await doSignUpTxn(user1PrivateKey);
    await doSetActionsRangeTxn();

    tree.setLeaf(3n, user1AsAccount.hash());
    let aw = tree.getWitness(3n);
    let accountWitness = new AccountWitness(aw);

    expect(async () => {
      zkApp.processSignUpRequestAction(accountWitness);
    }).rejects.toThrowError('assert_equal: 1 != 3');
  });

  test(`Feeding the 'processSignUpRequestAction' with an invalid witness throws
  the expected error`, async () => {
    await localDeploy();
    await doSignUpTxn(user1PrivateKey);
    await doSetActionsRangeTxn();
    const range1 = getActionsRange();
    for (let action of range1.actions) {
      await processSignUpAction(action, tree);
    }

    await doSignUpTxn(user2PrivateKey);
    await doSetActionsRangeTxn();
    const range2 = getActionsRange();
    let accountState = new Account({
      publicKey: range2.actions[0].publicKey,
      accountNumber: zkApp.accountNumber.get(),
      balance: range2.actions[0].balance,
      actionOrigin: range2.actions[0].actionOrigin,
    });
    const wrongTree = new MerkleTree(21);
    wrongTree.setLeaf(0n, Field(1));
    wrongTree.setLeaf(
      accountState.accountNumber.toBigInt(),
      accountState.hash()
    );
    let aw = wrongTree.getWitness(accountState.accountNumber.toBigInt());
    let accountWitness = new AccountWitness(aw);

    expect(async () => {
      zkApp.processSignUpRequestAction(accountWitness);
    }).rejects.toThrowError('assert_equal: 95689000');
  });

  test(`Trying to process an action not emitted by requestSignUp, with
  processSignUpRequestAction throws the expected error`, async () => {
    await localDeploy();
    await doSignUpTxn(user1PrivateKey);
    await doSetActionsRangeTxn();
    const range = getActionsRange();
    const { actionWithAccountNumber, accountWitness } =
      await processSignUpAction(range.actions[0], tree);

    const newUserPrivateKey = await createNewMinaAccount(user1PrivateKey, 1);
    await doReleaseFundsRequestTxn(
      user1PrivateKey,
      actionWithAccountNumber,
      accountWitness,
      newUserPrivateKey.toPublicKey(),
      1_000_000_000
    );
    await doSetActionsRangeTxn();

    const user2AccountNumber = zkApp.accountNumber.get().toBigInt();
    const aw2 = tree.getWitness(user2AccountNumber);
    const accountWitness2 = new AccountWitness(aw2);
    expect(async () => {
      zkApp.processSignUpRequestAction(accountWitness2);
    }).rejects.toThrowError('assert_equal: 2 != 1');
  });

  test(`when releaseFundsRequest is executed for 2 accounts already signed-up,
  2 releaseFundsRequest actions are properly emitted`, async () => {
    await localDeploy();

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(0));

    await doSignUpTxn(user1PrivateKey);
    await doSignUpTxn(user2PrivateKey);
    await doSetActionsRangeTxn();
    const range1 = getActionsRange();
    for (let action of range1.actions) {
      await processSignUpAction(action, tree);
    }

    expect(Mina.getBalance(zkAppAddress)).toEqual(
      UInt64.from(initialBalance).mul(2)
    );

    const newUserPrivateKey = await createNewMinaAccount(user1PrivateKey, 1);
    const newUserPublicKey = newUserPrivateKey.toPublicKey();

    user1AsAccount.actionOrigin = UInt32.from(1);
    const aw1 = tree.getWitness(1n);
    const accountWitness1 = new AccountWitness(aw1);
    await doReleaseFundsRequestTxn(
      user1PrivateKey,
      user1AsAccount,
      accountWitness1,
      newUserPublicKey,
      1_000_000_000
    );

    user2AsAccount.actionOrigin = UInt32.from(1);
    const aw2 = tree.getWitness(2n);
    const accountWitness2 = new AccountWitness(aw2);
    await doReleaseFundsRequestTxn(
      user2PrivateKey,
      user2AsAccount,
      accountWitness2,
      newUserPublicKey,
      2_500_000_000
    );

    await doSetActionsRangeTxn();
    const range2 = getActionsRange();

    expect(range2.actions[0]).toEqual(
      new Account({
        publicKey: user1AsAccount.publicKey,
        accountNumber: user1AsAccount.accountNumber,
        balance: initialBalance.sub(1_000_000_000),
        actionOrigin: releaseFundsRequestMethodID,
      })
    );

    expect(range2.actions[1]).toEqual(
      new Account({
        publicKey: user2AsAccount.publicKey,
        accountNumber: user2AsAccount.accountNumber,
        balance: initialBalance.sub(2_500_000_000),
        actionOrigin: releaseFundsRequestMethodID,
      })
    );
  });

  test(`contract admin can't send funds from the contract by just signing
  transactions`, async () => {
    await localDeploy();

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(0));

    await doSignUpTxn(user1PrivateKey);

    const newUserPrivateKey = await createNewMinaAccount(user1PrivateKey, 1);
    const newUserPublicKey = newUserPrivateKey.toPublicKey();

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(initialBalance));
    expect(Mina.getBalance(newUserPrivateKey.toPublicKey())).toEqual(
      UInt64.from(1)
    );

    /* Using zkApp.send fails silently without doing nothing, so we don't
     * expect any errors to be thrown by this, we just check later that it
     * actually did nothing.
     */
    const txn1 = await Mina.transaction(zkappKey, () => {
      zkApp.send({ to: newUserPublicKey, amount: UInt64.from(1_000_000_000) });
    });
    await txn1.prove();
    await txn1.sign([zkappKey]).send();

    // Second attempt to send funds using AccountUpdate
    const txn2 = await Mina.transaction(zkappKey, () => {
      AccountUpdate.create(zkAppAddress).send({
        to: newUserPublicKey,
        amount: UInt64.from(1_000_000_000),
      });
    });
    await txn2.prove();
    txn2.sign([zkappKey]);

    expect(async () => {
      await txn2.send();
    }).rejects.toThrowError('Update_not_permitted_balance');

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(initialBalance));
    expect(Mina.getBalance(newUserPublicKey)).toEqual(UInt64.from(1));
  });
});
