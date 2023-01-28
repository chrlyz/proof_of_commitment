import {
  isReady,
  shutdown,
  Mina,
  PrivateKey,
  PublicKey,
  AccountUpdate,
  Reducer,
  Field,
  UInt64,
  UInt32,
  MerkleMap,
  MerkleMapWitness,
  Poseidon,
} from 'snarkyjs';

import { Account } from './Account.js';

import {
  AccountManagement,
  root,
  initialBalance,
  signUpMethodID,
  releaseFundsRequestMethodID,
  addFundsRequestMethodID,
  serviceProviderAddress,
} from './AccountManagement.js';

let proofsEnabled = false;

describe('AccountManagement', () => {
  let deployerPrivateKey: PrivateKey,
    deployerPublicKey: PublicKey,
    zkAppAddress: PublicKey,
    zkappKey: PrivateKey,
    zkApp: AccountManagement,
    user1PrivateKey: PrivateKey,
    user2PrivateKey: PrivateKey,
    user1PublicKey: PublicKey,
    user2PublicKey: PublicKey,
    user1AsAccount: Account,
    user2AsAccount: Account,
    tree: MerkleMap;

  beforeAll(async () => {
    await isReady;
    if (proofsEnabled) AccountManagement.compile();
  });

  beforeEach(() => {
    const Local = Mina.LocalBlockchain({ proofsEnabled });
    Mina.setActiveInstance(Local);
    deployerPrivateKey = Local.testAccounts[0].privateKey;
    deployerPublicKey = deployerPrivateKey.toPublicKey();
    zkappKey = PrivateKey.random();
    zkAppAddress = zkappKey.toPublicKey();
    zkApp = new AccountManagement(zkAppAddress);
    user1PrivateKey = Local.testAccounts[1].privateKey;
    user2PrivateKey = Local.testAccounts[2].privateKey;
    user1PublicKey = user1PrivateKey.toPublicKey();
    user2PublicKey = user2PrivateKey.toPublicKey();
    user1AsAccount = new Account({
      publicKey: user1PublicKey,
      balance: initialBalance,
      actionOrigin: UInt32.from(0),
      released: UInt64.from(0),
    });
    user2AsAccount = new Account({
      publicKey: user2PublicKey,
      balance: initialBalance,
      actionOrigin: UInt32.from(0),
      released: UInt64.from(0),
    });
    tree = new MerkleMap();
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
    const txn = await Mina.transaction(deployerPublicKey, () => {
      AccountUpdate.fundNewAccount(deployerPublicKey);
      zkApp.deploy({ zkappKey });
    });
    await txn.prove();
    await txn.sign([deployerPrivateKey]).send();
  }

  async function processSignUpAction(action: Account) {
    action.actionOrigin.assertEquals(signUpMethodID);
    tree.set(Poseidon.hash(action.publicKey.toFields()), action.hash());
    let accountWitness = tree.getWitness(
      Poseidon.hash(action.publicKey.toFields())
    );

    const txn = await Mina.transaction(deployerPublicKey, () => {
      zkApp.processSignUpRequestAction(accountWitness);
    });
    await txn.prove();
    await txn.sign([deployerPrivateKey]).send();
    return { action: action, accountWitness: accountWitness };
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
    const txn = await Mina.transaction(userPrivateKey.toPublicKey(), () => {
      zkApp.requestSignUp(userPrivateKey.toPublicKey());
    });
    await txn.prove();
    await txn.sign([userPrivateKey]).send();
  }

  async function doSetActionsRangeTxn() {
    const txn = await Mina.transaction(deployerPublicKey, () => {
      zkApp.setRangeOfActionsToBeProcessed();
    });
    await txn.prove();
    await txn.sign([deployerPrivateKey]).send();
  }

  async function doReleaseFundsRequestTxn(
    releaser: PrivateKey,
    releaserAccount: Account,
    accountWitness: MerkleMapWitness,
    amount: UInt64
  ) {
    const txn = await Mina.transaction(releaser.toPublicKey(), () => {
      zkApp.releaseFundsRequest(releaserAccount, accountWitness, amount);
    });
    await txn.prove();
    await txn.sign([releaser]).send();
  }

  /*   async function createNewMinaAccount(sponsor: PrivateKey, amount: number) {
    const newUserPrivateKey = PrivateKey.random();
    const sponsorPublicKey = sponsor.toPublicKey();

    const txn = await Mina.transaction(sponsorPublicKey, () => {
      const accountUpdate = AccountUpdate.fundNewAccount(sponsorPublicKey);
      accountUpdate.send({ to: newUserPrivateKey.toPublicKey(), amount });
    });
    await txn.prove();
    await txn.sign([sponsor]).send();
    return newUserPrivateKey;
  } */

  async function processReleaseFundsAction(
    action: Account,
    accountState: Account
  ) {
    action.actionOrigin.assertEquals(releaseFundsRequestMethodID);
    action.balance = action.balance.sub(action.released);
    action.released = UInt64.from(0);
    tree.set(Poseidon.hash(action.publicKey.toFields()), action.hash());
    let accountWitness = tree.getWitness(
      Poseidon.hash(action.publicKey.toFields())
    );

    const txn = await Mina.transaction(deployerPublicKey, () => {
      zkApp.processReleaseFundsRequest(accountState, accountWitness);
    });
    await txn.prove();
    await txn.sign([deployerPrivateKey]).send();
  }

  async function doAddFundsRequestTxn(
    funder: PrivateKey,
    funderAccount: Account,
    accountWitness: MerkleMapWitness,
    amount: UInt64
  ) {
    const txn = await Mina.transaction(funder.toPublicKey(), () => {
      zkApp.addFundsRequest(funderAccount, accountWitness, amount);
    });
    await txn.prove();
    await txn.sign([funder]).send();
  }

  async function createProviderAccount() {
    const txn = await Mina.transaction(deployerPublicKey, () => {
      const accountUpdate = AccountUpdate.fundNewAccount(deployerPublicKey);
      accountUpdate.send({ to: serviceProviderAddress, amount: 1 });
    });
    await txn.prove();
    await txn.sign([deployerPrivateKey]).send();
  }

  async function processAddFundsAction(action: Account, accountState: Account) {
    action.actionOrigin.assertEquals(addFundsRequestMethodID);
    tree.set(Poseidon.hash(action.publicKey.toFields()), action.hash());
    let accountWitness = tree.getWitness(
      Poseidon.hash(action.publicKey.toFields())
    );

    const txn = await Mina.transaction(deployerPublicKey, () => {
      zkApp.processAddFundsRequest(accountState, accountWitness);
    });
    await txn.prove();
    await txn.sign([deployerPrivateKey]).send();
  }

  it(`successfully deploys the AccountManagement smart contract`, async () => {
    await localDeploy();

    const startOfAllActions = zkApp.startOfAllActions.get();
    const numberOfPendingActions = zkApp.numberOfPendingActions.get();
    const actionTurn = zkApp.actionTurn.get();
    const startOfActionsRange = zkApp.startOfActionsRange.get();
    const endOfActionsRange = zkApp.endOfActionsRange.get();
    const accountsRoot = zkApp.accountsRoot.get();

    expect(startOfAllActions).toEqual(Reducer.initialActionsHash);
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
    expect(actions[0].publicKey).toEqual(user1PublicKey);
    expect(actions[0].balance).toEqual(initialBalance);
    expect(actions[0].actionOrigin).toEqual(signUpMethodID);
  });

  it(`emits 2 proper sign-up request actions when the requestSignUp method is
  executed 2 times with different accounts`, async () => {
    await localDeploy();

    await doSignUpTxn(user1PrivateKey);
    await doSignUpTxn(user2PrivateKey);
    const actions = getAllActions();

    expect(actions.length).toEqual(2);
    expect(actions[0].publicKey).toEqual(user1PublicKey);
    expect(actions[0].balance).toEqual(initialBalance);
    expect(actions[0].actionOrigin).toEqual(signUpMethodID);
    expect(actions[1].publicKey).toEqual(user2PublicKey);
    expect(actions[1].balance).toEqual(initialBalance);
    expect(actions[1].actionOrigin).toEqual(signUpMethodID);
  });

  it(`throws an error when a requestSignUp transaction is not signed by the
  account requesting to sign-up`, async () => {
    await localDeploy();

    const txn = await Mina.transaction(user1PublicKey, () => {
      zkApp.requestSignUp(user1PublicKey);
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
      await processSignUpAction(action);
    }

    user1AsAccount.actionOrigin = signUpMethodID;
    user2AsAccount.actionOrigin = signUpMethodID;

    let expectedTree = new MerkleMap();
    expectedTree.set(
      Poseidon.hash(user1AsAccount.publicKey.toFields()),
      user1AsAccount.hash()
    );
    expectedTree.set(
      Poseidon.hash(user2AsAccount.publicKey.toFields()),
      user2AsAccount.hash()
    );
    const expectedTreeRoot = expectedTree.getRoot();

    expect(zkApp.accountsRoot.get()).toEqual(expectedTreeRoot);
    expect(zkApp.numberOfPendingActions.get()).toEqual(Field(0));
    expect(zkApp.actionTurn.get()).toEqual(Field(2));
  });

  test(`processSignUpRequestAction processes a sign-up request emitted after it
  processed another`, async () => {
    await localDeploy();

    await doSignUpTxn(user1PrivateKey);
    await doSetActionsRangeTxn();

    user1AsAccount.actionOrigin = signUpMethodID;
    let expectedTree = new MerkleMap();
    expectedTree.set(
      Poseidon.hash(user1AsAccount.publicKey.toFields()),
      user1AsAccount.hash()
    );
    const expectedTreeRoot1 = expectedTree.getRoot();

    const range1 = getActionsRange();
    for (let action of range1.actions) {
      await processSignUpAction(action);
    }

    expect(zkApp.accountsRoot.get()).toEqual(expectedTreeRoot1);
    expect(zkApp.numberOfPendingActions.get()).toEqual(Field(0));
    expect(zkApp.actionTurn.get()).toEqual(Field(1));

    await doSignUpTxn(user2PrivateKey);
    await doSetActionsRangeTxn();

    user2AsAccount.actionOrigin = signUpMethodID;
    expectedTree.set(
      Poseidon.hash(user2AsAccount.publicKey.toFields()),
      user2AsAccount.hash()
    );
    const expectedTreeRoot2 = expectedTree.getRoot();

    const range2 = getActionsRange();
    for (let action of range2.actions) {
      await processSignUpAction(action);
    }

    expect(zkApp.accountsRoot.get()).toEqual(expectedTreeRoot2);
    expect(zkApp.numberOfPendingActions.get()).toEqual(Field(0));
    expect(zkApp.actionTurn.get()).toEqual(Field(1));
  });

  test(`Trying to process an action not emitted by requestSignUp, with
  processSignUpRequestAction throws the expected error`, async () => {
    await localDeploy();
    await doSignUpTxn(user1PrivateKey);
    await doSetActionsRangeTxn();
    const range1 = getActionsRange();
    const { action, accountWitness } = await processSignUpAction(
      range1.actions[0]
    );

    await doReleaseFundsRequestTxn(
      user1PrivateKey,
      action,
      accountWitness,
      UInt64.from(1_000_000_000)
    );

    await doSetActionsRangeTxn();
    let user2AccountWitness = tree.getWitness(
      Poseidon.hash(user2PublicKey.toFields())
    );
    expect(async () => {
      zkApp.processSignUpRequestAction(user2AccountWitness);
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
      await processSignUpAction(action);
    }

    expect(Mina.getBalance(zkAppAddress)).toEqual(
      UInt64.from(initialBalance).mul(2)
    );

    user1AsAccount.actionOrigin = signUpMethodID;
    const range2 = getActionsRange();
    let user1AccountWitness = tree.getWitness(
      Poseidon.hash(range2.actions[0].publicKey.toFields())
    );
    await doReleaseFundsRequestTxn(
      user1PrivateKey,
      user1AsAccount,
      user1AccountWitness,
      UInt64.from(1_000_000_000)
    );

    user2AsAccount.actionOrigin = signUpMethodID;
    let user2AccountWitness = tree.getWitness(
      Poseidon.hash(range2.actions[1].publicKey.toFields())
    );
    await doReleaseFundsRequestTxn(
      user2PrivateKey,
      user2AsAccount,
      user2AccountWitness,
      UInt64.from(2_500_000_000)
    );

    await doSetActionsRangeTxn();
    const range3 = getActionsRange();

    expect(range3.actions[0]).toEqual(
      new Account({
        publicKey: user1AsAccount.publicKey,
        balance: initialBalance,
        actionOrigin: releaseFundsRequestMethodID,
        released: UInt64.from(1_000_000_000),
      })
    );

    expect(range3.actions[1]).toEqual(
      new Account({
        publicKey: user2AsAccount.publicKey,
        balance: initialBalance,
        actionOrigin: releaseFundsRequestMethodID,
        released: UInt64.from(2_500_000_000),
      })
    );
  });

  test(`if releaser doesn't signs a releaseFunds transaction it fails`, async () => {
    await localDeploy();
    await doSignUpTxn(user1PrivateKey);
    await doSetActionsRangeTxn();
    const range1 = getActionsRange();
    await processSignUpAction(range1.actions[0]);

    user1AsAccount.actionOrigin = signUpMethodID;
    const range2 = getActionsRange();
    let user1AccountWitness = tree.getWitness(
      Poseidon.hash(range2.actions[0].publicKey.toFields())
    );

    const txn = await Mina.transaction(user1PublicKey, () => {
      zkApp.releaseFundsRequest(
        user1AsAccount,
        user1AccountWitness,
        UInt64.from(4_000_000_000)
      );
    });
    await txn.prove();

    expect(async () => {
      await txn.send();
    }).rejects.toThrowError('private key is missing');
  });

  test(`contract admin can't send funds from the contract by just signing
  transactions`, async () => {
    await localDeploy();
    await createProviderAccount();

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(0));

    await doSignUpTxn(user1PrivateKey);

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(initialBalance));
    expect(Mina.getBalance(serviceProviderAddress)).toEqual(UInt64.from(1));

    /* Using zkApp.send fails silently without doing nothing, so we don't
     * expect any errors to be thrown by this, we just check later that it
     * actually did nothing.
     */
    const txn1 = await Mina.transaction(zkappKey.toPublicKey(), () => {
      zkApp.send({
        to: serviceProviderAddress,
        amount: UInt64.from(1_000_000_000),
      });
    });
    await txn1.prove();
    await txn1.sign([zkappKey]).send();

    // Second attempt to send funds using AccountUpdate
    const txn2 = await Mina.transaction(zkAppAddress, () => {
      AccountUpdate.create(zkAppAddress).send({
        to: serviceProviderAddress,
        amount: UInt64.from(1_000_000_000),
      });
    });
    await txn2.prove();
    txn2.sign([zkappKey]);

    expect(async () => {
      await txn2.send();
    }).rejects.toThrowError('Update_not_permitted_balance');

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(initialBalance));
    expect(Mina.getBalance(serviceProviderAddress)).toEqual(UInt64.from(1));
  });

  test(`releaseFundsRequest doesn't allow a user to request releasing more
  balance than they have`, async () => {
    await localDeploy();
    await doSignUpTxn(user1PrivateKey);
    await doSetActionsRangeTxn();
    const range1 = getActionsRange();
    await processSignUpAction(range1.actions[0]);

    user1AsAccount.actionOrigin = signUpMethodID;
    const range2 = getActionsRange();
    let user1AccountWitness = tree.getWitness(
      Poseidon.hash(range2.actions[0].publicKey.toFields())
    );

    expect(async () => {
      await doReleaseFundsRequestTxn(
        user1PrivateKey,
        user1AsAccount,
        user1AccountWitness,
        UInt64.from(6_666_666_666)
      );
    }).rejects.toThrowError(/Expected [0-9]+ to fit in 64 bits/);
  });

  test(`when processReleaseFundsRequest is executed for 2 release funds
  requests, the balances of the involved parties change accordingly, and
  accountsRoot is updated`, async () => {
    await localDeploy();
    await createProviderAccount();

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(0));

    await doSignUpTxn(user1PrivateKey);
    await doSignUpTxn(user2PrivateKey);
    await doSetActionsRangeTxn();
    const range1 = getActionsRange();
    for (let action of range1.actions) {
      await processSignUpAction(action);
    }

    expect(Mina.getBalance(zkAppAddress)).toEqual(
      UInt64.from(initialBalance).mul(2)
    );

    user1AsAccount.actionOrigin = signUpMethodID;
    const range2 = getActionsRange();
    let user1AccountWitness = tree.getWitness(
      Poseidon.hash(range2.actions[0].publicKey.toFields())
    );
    await doReleaseFundsRequestTxn(
      user1PrivateKey,
      user1AsAccount,
      user1AccountWitness,
      UInt64.from(1_000_000_000)
    );

    user2AsAccount.actionOrigin = signUpMethodID;
    let user2AccountWitness = tree.getWitness(
      Poseidon.hash(range2.actions[1].publicKey.toFields())
    );
    await doReleaseFundsRequestTxn(
      user2PrivateKey,
      user2AsAccount,
      user2AccountWitness,
      UInt64.from(2_500_000_000)
    );

    const initialRoot = zkApp.accountsRoot.get();
    await doSetActionsRangeTxn();
    const range3 = getActionsRange();
    await processReleaseFundsAction(range3.actions[0], user1AsAccount);
    await processReleaseFundsAction(range3.actions[1], user2AsAccount);

    expect(initialRoot).not.toEqual(zkApp.accountsRoot.get());
    expect(Mina.getBalance(zkAppAddress)).toEqual(
      UInt64.from(initialBalance).mul(2).sub(1_000_000_000).sub(2_500_000_000)
    );
    expect(Mina.getBalance(serviceProviderAddress)).toEqual(
      UInt64.from(1).add(1_000_000_000).add(2_500_000_000)
    );
  });

  test(`processReleaseFundsRequest processes a release funds request emitted
  after it processed another`, async () => {
    await localDeploy();
    await createProviderAccount();

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(0));

    await doSignUpTxn(user1PrivateKey);
    await doSignUpTxn(user2PrivateKey);
    await doSetActionsRangeTxn();
    const range1 = getActionsRange();
    for (let action of range1.actions) {
      await processSignUpAction(action);
    }

    expect(Mina.getBalance(zkAppAddress)).toEqual(
      UInt64.from(initialBalance).mul(2)
    );

    user1AsAccount.actionOrigin = signUpMethodID;
    const range2 = getActionsRange();
    let user1AccountWitness = tree.getWitness(
      Poseidon.hash(range2.actions[0].publicKey.toFields())
    );
    await doReleaseFundsRequestTxn(
      user1PrivateKey,
      user1AsAccount,
      user1AccountWitness,
      UInt64.from(3_333_333_333)
    );

    const initialRoot1 = zkApp.accountsRoot.get();
    await doSetActionsRangeTxn();
    const range3 = getActionsRange();
    await processReleaseFundsAction(range3.actions[0], user1AsAccount);

    expect(initialRoot1).not.toEqual(zkApp.accountsRoot.get());
    expect(Mina.getBalance(zkAppAddress)).toEqual(
      UInt64.from(initialBalance).mul(2).sub(3_333_333_333)
    );
    expect(Mina.getBalance(serviceProviderAddress)).toEqual(
      UInt64.from(1).add(3_333_333_333)
    );

    user2AsAccount.actionOrigin = signUpMethodID;
    let user2AccountWitness = tree.getWitness(
      Poseidon.hash(range2.actions[1].publicKey.toFields())
    );
    await doReleaseFundsRequestTxn(
      user2PrivateKey,
      user2AsAccount,
      user2AccountWitness,
      UInt64.from(1_111_111_111)
    );

    const initialRoot2 = zkApp.accountsRoot.get();
    await doSetActionsRangeTxn();
    const range4 = getActionsRange();
    await processReleaseFundsAction(range4.actions[0], user2AsAccount);

    expect(initialRoot2).not.toEqual(zkApp.accountsRoot.get());
    expect(Mina.getBalance(zkAppAddress)).toEqual(
      UInt64.from(initialBalance).mul(2).sub(3_333_333_333).sub(1_111_111_111)
    );
    expect(Mina.getBalance(serviceProviderAddress)).toEqual(
      UInt64.from(1).add(3_333_333_333).add(1_111_111_111)
    );
  });

  test(`Trying to process an action not emitted by releaseFundsRequest, with
  processReleaseFundsRequest throws the expected error`, async () => {
    await localDeploy();
    await doSignUpTxn(user1PrivateKey);
    await doSetActionsRangeTxn();
    const range1 = getActionsRange();
    await processSignUpAction(range1.actions[0]);

    await doSignUpTxn(user2PrivateKey);
    await doSetActionsRangeTxn();
    user1AsAccount.actionOrigin = signUpMethodID;
    const range2 = getActionsRange();

    expect(async () => {
      await processReleaseFundsAction(range2.actions[0], user1AsAccount);
    }).rejects.toThrowError('assert_equal: 1 != 2');
  });

  test(`when addFundsRequest is executed for 2 accounts already signed-up,
  the respective balances are updated and 2 addFundsRequest actions are
  emitted properly`, async () => {
    await localDeploy();

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(0));

    await doSignUpTxn(user1PrivateKey);
    await doSignUpTxn(user2PrivateKey);
    await doSetActionsRangeTxn();
    const range1 = getActionsRange();
    for (let action of range1.actions) {
      await processSignUpAction(action);
    }

    expect(Mina.getBalance(zkAppAddress)).toEqual(
      UInt64.from(initialBalance).mul(2)
    );

    user1AsAccount.actionOrigin = signUpMethodID;
    const range2 = getActionsRange();
    let user1AccountWitness = tree.getWitness(
      Poseidon.hash(range2.actions[0].publicKey.toFields())
    );
    await doAddFundsRequestTxn(
      user1PrivateKey,
      user1AsAccount,
      user1AccountWitness,
      UInt64.from(1_000_000_000)
    );

    expect(Mina.getBalance(zkAppAddress)).toEqual(
      UInt64.from(initialBalance).mul(2).add(1_000_000_000)
    );

    user2AsAccount.actionOrigin = signUpMethodID;
    let user2AccountWitness = tree.getWitness(
      Poseidon.hash(range2.actions[1].publicKey.toFields())
    );
    await doAddFundsRequestTxn(
      user2PrivateKey,
      user2AsAccount,
      user2AccountWitness,
      UInt64.from(2_500_000_000)
    );

    expect(Mina.getBalance(zkAppAddress)).toEqual(
      UInt64.from(initialBalance).mul(2).add(3_500_000_000)
    );

    await doSetActionsRangeTxn();
    const range3 = getActionsRange();

    expect(range3.actions[0]).toEqual(
      new Account({
        publicKey: user1AsAccount.publicKey,
        balance: initialBalance.add(1_000_000_000),
        actionOrigin: addFundsRequestMethodID,
        released: UInt64.from(0),
      })
    );
    expect(range3.actions[1]).toEqual(
      new Account({
        publicKey: user2AsAccount.publicKey,
        balance: initialBalance.add(2_500_000_000),
        actionOrigin: addFundsRequestMethodID,
        released: UInt64.from(0),
      })
    );
  });

  test(`if funder doesn't signs a addFundsRequest transaction it fails`, async () => {
    await localDeploy();
    await doSignUpTxn(user1PrivateKey);
    await doSetActionsRangeTxn();
    const range1 = getActionsRange();
    await processSignUpAction(range1.actions[0]);

    user1AsAccount.actionOrigin = signUpMethodID;
    const range2 = getActionsRange();
    let user1AccountWitness = tree.getWitness(
      Poseidon.hash(range2.actions[0].publicKey.toFields())
    );

    const txn = await Mina.transaction(user1PublicKey, () => {
      zkApp.addFundsRequest(
        user1AsAccount,
        user1AccountWitness,
        UInt64.from(4_000_000_000)
      );
    });
    await txn.prove();

    expect(async () => {
      await txn.send();
    }).rejects.toThrowError('private key is missing');
  });

  test(`processAddFundsRequest processes 2 add funds requests, and updates
  accountsRoot successfully`, async () => {
    await localDeploy();
    await createProviderAccount();
    await doSignUpTxn(user1PrivateKey);
    await doSignUpTxn(user2PrivateKey);
    await doSetActionsRangeTxn();
    const range1 = getActionsRange();
    for (let action of range1.actions) {
      await processSignUpAction(action);
    }

    user1AsAccount.actionOrigin = signUpMethodID;
    const range2 = getActionsRange();
    let user1AccountWitness = tree.getWitness(
      Poseidon.hash(range2.actions[0].publicKey.toFields())
    );
    await doAddFundsRequestTxn(
      user1PrivateKey,
      user1AsAccount,
      user1AccountWitness,
      UInt64.from(1_000_000_000)
    );

    user2AsAccount.actionOrigin = signUpMethodID;
    let user2AccountWitness = tree.getWitness(
      Poseidon.hash(range2.actions[1].publicKey.toFields())
    );
    await doAddFundsRequestTxn(
      user2PrivateKey,
      user2AsAccount,
      user2AccountWitness,
      UInt64.from(2_500_000_000)
    );

    const initialRoot = zkApp.accountsRoot.get();

    await doSetActionsRangeTxn();
    const range3 = getActionsRange();
    await processAddFundsAction(range3.actions[0], user1AsAccount);
    await processAddFundsAction(range3.actions[1], user2AsAccount);

    expect(initialRoot).not.toEqual(zkApp.accountsRoot.get());
    expect(zkApp.numberOfPendingActions.get()).toEqual(Field(0));
    expect(zkApp.actionTurn.get()).toEqual(Field(2));
  });

  test(`processAddFundsRequest processes an add funds request emitted
  after it processed another`, async () => {
    await localDeploy();
    await createProviderAccount();

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(0));

    await doSignUpTxn(user1PrivateKey);
    await doSignUpTxn(user2PrivateKey);
    await doSetActionsRangeTxn();
    const range1 = getActionsRange();
    for (let action of range1.actions) {
      await processSignUpAction(action);
    }

    expect(Mina.getBalance(zkAppAddress)).toEqual(
      UInt64.from(initialBalance).mul(2)
    );

    user1AsAccount.actionOrigin = signUpMethodID;
    const range2 = getActionsRange();
    let user1AccountWitness = tree.getWitness(
      Poseidon.hash(range2.actions[0].publicKey.toFields())
    );
    await doAddFundsRequestTxn(
      user1PrivateKey,
      user1AsAccount,
      user1AccountWitness,
      UInt64.from(3_333_333_333)
    );

    const initialRoot1 = zkApp.accountsRoot.get();
    await doSetActionsRangeTxn();
    const range3 = getActionsRange();
    await processAddFundsAction(range3.actions[0], user1AsAccount);

    expect(initialRoot1).not.toEqual(zkApp.accountsRoot.get());
    expect(zkApp.numberOfPendingActions.get()).toEqual(Field(0));
    expect(zkApp.actionTurn.get()).toEqual(Field(1));

    user2AsAccount.actionOrigin = signUpMethodID;
    user2AsAccount.actionOrigin = signUpMethodID;
    let user2AccountWitness = tree.getWitness(
      Poseidon.hash(range2.actions[1].publicKey.toFields())
    );
    await doAddFundsRequestTxn(
      user2PrivateKey,
      user2AsAccount,
      user2AccountWitness,
      UInt64.from(1_111_111_111)
    );

    const initialRoot2 = zkApp.accountsRoot.get();
    await doSetActionsRangeTxn();
    const range4 = getActionsRange();
    await processAddFundsAction(range4.actions[0], user2AsAccount);

    expect(initialRoot2).not.toEqual(zkApp.accountsRoot.get());
    expect(zkApp.numberOfPendingActions.get()).toEqual(Field(0));
    expect(zkApp.actionTurn.get()).toEqual(Field(1));
  });

  test(`Trying to process an action not emitted by addFundsRequest, with
  processAddFundsRequest throws the expected error`, async () => {
    await localDeploy();
    await doSignUpTxn(user1PrivateKey);
    await doSetActionsRangeTxn();
    const range1 = getActionsRange();
    await processSignUpAction(range1.actions[0]);

    await doSignUpTxn(user2PrivateKey);
    await doSetActionsRangeTxn();
    user1AsAccount.actionOrigin = signUpMethodID;
    const range2 = getActionsRange();

    expect(async () => {
      await processAddFundsAction(range2.actions[0], user1AsAccount);
    }).rejects.toThrowError('assert_equal: 1 != 3');
  });
});
