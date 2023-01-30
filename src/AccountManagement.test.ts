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
  signUpRequestID,
  addFundsRequestMethodID,
  releaseFundsRequestMethodID,
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
      balance: UInt64.from(0),
      actionOrigin: UInt32.from(0),
      released: UInt64.from(0),
    });
    user2AsAccount = new Account({
      publicKey: user2PublicKey,
      balance: UInt64.from(0),
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

  async function doSignUpRequestTxn(userKey: PrivateKey) {
    const userAccountWitness = tree.getWitness(
      Poseidon.hash(userKey.toFields())
    );
    const txn = await Mina.transaction(userKey.toPublicKey(), () => {
      zkApp.signUpRequest(userKey.toPublicKey(), userAccountWitness);
    });
    await txn.prove();
    await txn.sign([userKey]).send();
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

  async function doSetActionsRangeTxn() {
    const txn = await Mina.transaction(deployerPublicKey, () => {
      zkApp.setRangeOfActionsToBeProcessed();
    });
    await txn.prove();
    await txn.sign([deployerPrivateKey]).send();
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

  async function processSignUpAction(action: Account) {
    action.actionOrigin.assertEquals(signUpRequestID);

    const userAccountWitness = tree.getWitness(
      Poseidon.hash(action.publicKey.toFields())
    );

    const txn = await Mina.transaction(deployerPublicKey, () => {
      zkApp.processSignUpRequest(userAccountWitness);
    });
    await txn.prove();
    await txn.sign([deployerPrivateKey]).send();

    tree.set(
      userAccountWitness.computeRootAndKey(action.hash())[1],
      action.hash()
    );
  }

  async function processAddFundsAction(action: Account, accountState: Account) {
    action.actionOrigin.assertEquals(addFundsRequestMethodID);

    const accountWitness = tree.getWitness(
      Poseidon.hash(accountState.publicKey.toFields())
    );

    const txn = await Mina.transaction(deployerPublicKey, () => {
      zkApp.processAddFundsRequest(accountState, accountWitness);
    });
    await txn.prove();
    await txn.sign([deployerPrivateKey]).send();

    accountState.balance = accountState.balance.add(action.balance);
    accountState.actionOrigin = addFundsRequestMethodID;
    tree.set(
      Poseidon.hash(accountState.publicKey.toFields()),
      accountState.hash()
    );
    return accountState;
  }

  async function processReleaseFundsAction(
    action: Account,
    accountState: Account
  ) {
    action.actionOrigin.assertEquals(releaseFundsRequestMethodID);

    let accountWitness = tree.getWitness(
      Poseidon.hash(accountState.publicKey.toFields())
    );

    const txn = await Mina.transaction(deployerPublicKey, () => {
      zkApp.processReleaseFundsRequest(accountState, accountWitness);
    });
    await txn.prove();
    await txn.sign([deployerPrivateKey]).send();

    accountState.balance = action.balance.sub(action.released);
    accountState.released = UInt64.from(0);
    accountState.actionOrigin = releaseFundsRequestMethodID;
    tree.set(
      Poseidon.hash(accountState.publicKey.toFields()),
      accountState.hash()
    );
    return accountState;
  }

  async function createProviderAccount() {
    const txn = await Mina.transaction(deployerPublicKey, () => {
      const accountUpdate = AccountUpdate.fundNewAccount(deployerPublicKey);
      accountUpdate.send({ to: serviceProviderAddress, amount: 1 });
    });
    await txn.prove();
    await txn.sign([deployerPrivateKey]).send();
  }

  it(`successfully deploys the AccountManagement smart contract`, async () => {
    await localDeploy();

    const numberOfPendingActions = zkApp.numberOfPendingActions.get();
    const actionTurn = zkApp.actionTurn.get();
    const startOfActionsRange = zkApp.startOfActionsRange.get();
    const endOfActionsRange = zkApp.endOfActionsRange.get();
    const accountsRoot = zkApp.accountsRoot.get();

    expect(numberOfPendingActions).toEqual(Field(0));
    expect(actionTurn).toEqual(Field(0));
    expect(startOfActionsRange).toEqual(Reducer.initialActionsHash);
    expect(endOfActionsRange).toEqual(Reducer.initialActionsHash);
    expect(accountsRoot).toEqual(root);
  });

  it(`emits proper sign-up request action when the requestSignUp method
  is executed`, async () => {
    await localDeploy();

    await doSignUpRequestTxn(user1PrivateKey);
    const range = getActionsRange();

    expect(range.actions.length).toEqual(1);
    expect(range.actions[0].publicKey).toEqual(user1PublicKey);
    expect(range.actions[0].balance).toEqual(UInt64.from(0));
    expect(range.actions[0].actionOrigin).toEqual(signUpRequestID);
    expect(range.actions[0].released).toEqual(UInt64.from(0));
  });

  it(`throws an error when a requestSignUp transaction is not signed by the
  account requesting to sign-up`, async () => {
    await localDeploy();
    const user1AccountWitness = tree.getWitness(
      Poseidon.hash(user1PublicKey.toFields())
    );
    const txn = await Mina.transaction(user1PublicKey, () => {
      zkApp.signUpRequest(user1PublicKey, user1AccountWitness);
    });
    await txn.prove();

    expect(async () => {
      await txn.send();
    }).rejects.toThrowError('private key is missing');
  });

  it(`processing duplicated requestSignUp actions only update the root the
  first time, and emission of actions and its processing can proceed `, async () => {
    await localDeploy();
    const initialRoot = zkApp.accountsRoot.get();

    await doSignUpRequestTxn(user1PrivateKey);
    await doSetActionsRangeTxn();
    const range1 = getActionsRange();
    await processSignUpAction(range1.actions[0]);
    expect(initialRoot).not.toEqual(zkApp.accountsRoot.get());

    let updatedRoot = zkApp.accountsRoot.get();

    await doSignUpRequestTxn(user1PrivateKey);
    await doSetActionsRangeTxn();
    const range2 = getActionsRange();
    await processSignUpAction(range2.actions[0]);
    expect(updatedRoot).toEqual(zkApp.accountsRoot.get());

    updatedRoot = zkApp.accountsRoot.get();

    await doSignUpRequestTxn(user2PrivateKey);
    await doSetActionsRangeTxn();
    const range3 = getActionsRange();
    await processSignUpAction(range3.actions[0]);
    expect(updatedRoot).not.toEqual(zkApp.accountsRoot.get());
  });

  test(`Trying to process an empty range of actions doesn't changes any
  contract state`, async () => {
    await localDeploy();
    const numberOfPendingActions = zkApp.numberOfPendingActions.get();
    const actionTurn = zkApp.actionTurn.get();
    const startOfActionsRange = zkApp.startOfActionsRange.get();
    const endOfActionsRange = zkApp.endOfActionsRange.get();
    const accountsRoot = zkApp.accountsRoot.get();

    // Empty range.
    await processSignUpAction(user1AsAccount);

    expect(numberOfPendingActions).toEqual(Field(0));
    expect(actionTurn).toEqual(Field(0));
    expect(startOfActionsRange).toEqual(Reducer.initialActionsHash);
    expect(endOfActionsRange).toEqual(Reducer.initialActionsHash);
    expect(accountsRoot).toEqual(root);
  });

  test(`Trying to process an action not emitted by requestSignUp with
  processSignUpRequest throws the expected error`, async () => {
    await localDeploy();
    await doSignUpRequestTxn(user1PrivateKey);
    await doSetActionsRangeTxn();
    const range1 = getActionsRange();
    await processSignUpAction(range1.actions[0]);

    let user1AccountWitness = tree.getWitness(
      Poseidon.hash(user1AsAccount.publicKey.toFields())
    );

    await doAddFundsRequestTxn(
      user1PrivateKey,
      user1AsAccount,
      user1AccountWitness,
      UInt64.from(4_000_000_000)
    );

    // Action not emitted by requestSignUp.
    await doSetActionsRangeTxn();
    const range2 = getActionsRange();
    expect(async () => {
      await processSignUpAction(range2.actions[0]);
    }).rejects.toThrowError(
      `assert_equal: ${addFundsRequestMethodID} != ${signUpRequestID}`
    );
  });

  test(`number of pending actions and the action hashes for the range remain
  unchanged when setRangeOfActionsToBeProcessed is executed when no actions
  have been emitted`, async () => {
    await localDeploy();

    const numberOfPendingActions = zkApp.numberOfPendingActions.get();
    const startOfActionsRange = zkApp.startOfActionsRange.get();
    const endOfActionsRange = zkApp.endOfActionsRange.get();

    await doSetActionsRangeTxn();

    expect(numberOfPendingActions).toEqual(Field(0));
    expect(startOfActionsRange).toEqual(Reducer.initialActionsHash);
    expect(endOfActionsRange).toEqual(Reducer.initialActionsHash);
  });

  test(`number of pending actions and the action hash for the end of the range
  get updated properly when setRangeOfActionsToBeProcessed is executed when
  2 actions have been emitted`, async () => {
    await localDeploy();

    await doSignUpRequestTxn(user1PrivateKey);
    await doSignUpRequestTxn(user2PrivateKey);

    await doSetActionsRangeTxn();

    const expectedNumberOfPendingActions = 2;
    const numberOfPendingActions = zkApp.numberOfPendingActions.get();
    const range = getActionsRange();

    expect(numberOfPendingActions).toEqual(
      Field(expectedNumberOfPendingActions)
    );
    expect(range.actions.length).toEqual(expectedNumberOfPendingActions);
  });

  test(`2 releaseFundsRequest actions are properly emitted when
  releaseFundsRequest is executed for 2 accounts with enough funds`, async () => {
    await localDeploy();

    await doSignUpRequestTxn(user1PrivateKey);
    await doSignUpRequestTxn(user2PrivateKey);

    await doSetActionsRangeTxn();
    const range1 = getActionsRange();
    await processSignUpAction(range1.actions[0]);
    await processSignUpAction(range1.actions[1]);

    let user1AccountWitness = tree.getWitness(
      Poseidon.hash(user1AsAccount.publicKey.toFields())
    );
    let user2AccountWitness = tree.getWitness(
      Poseidon.hash(user2AsAccount.publicKey.toFields())
    );

    await doAddFundsRequestTxn(
      user1PrivateKey,
      user1AsAccount,
      user1AccountWitness,
      UInt64.from(4_000_000_000)
    );

    await doAddFundsRequestTxn(
      user2PrivateKey,
      user2AsAccount,
      user2AccountWitness,
      UInt64.from(4_000_000_000)
    );

    await doSetActionsRangeTxn();
    const range2 = getActionsRange();
    let user1AccountState = await processAddFundsAction(
      range2.actions[0],
      user1AsAccount
    );
    let user2AccountState = await processAddFundsAction(
      range2.actions[1],
      user2AsAccount
    );

    user1AccountWitness = tree.getWitness(
      Poseidon.hash(user1AsAccount.publicKey.toFields())
    );
    user2AccountWitness = tree.getWitness(
      Poseidon.hash(user2AsAccount.publicKey.toFields())
    );

    await doReleaseFundsRequestTxn(
      user1PrivateKey,
      user1AccountState,
      user1AccountWitness,
      UInt64.from(1_000_000_000)
    );

    await doReleaseFundsRequestTxn(
      user2PrivateKey,
      user2AccountState,
      user2AccountWitness,
      UInt64.from(2_500_000_000)
    );

    await doSetActionsRangeTxn();
    const range3 = getActionsRange();

    expect(range3.actions[0]).toEqual(
      new Account({
        publicKey: user1AsAccount.publicKey,
        balance: user1AsAccount.balance,
        actionOrigin: releaseFundsRequestMethodID,
        released: UInt64.from(1_000_000_000),
      })
    );

    expect(range3.actions[1]).toEqual(
      new Account({
        publicKey: user2AsAccount.publicKey,
        balance: user2AsAccount.balance,
        actionOrigin: releaseFundsRequestMethodID,
        released: UInt64.from(2_500_000_000),
      })
    );
  });

  test(`if releaser doesn't signs a releaseFunds transaction it fails`, async () => {
    await localDeploy();
    await doSignUpRequestTxn(user1PrivateKey);

    await doSetActionsRangeTxn();
    const range1 = getActionsRange();
    await processSignUpAction(range1.actions[0]);

    const user1AccountWitness = tree.getWitness(
      Poseidon.hash(user1AsAccount.publicKey.toFields())
    );
    await doAddFundsRequestTxn(
      user1PrivateKey,
      user1AsAccount,
      user1AccountWitness,
      UInt64.from(1_000_000_000)
    );

    await doSetActionsRangeTxn();
    const range2 = getActionsRange();
    await processAddFundsAction(range2.actions[0], user1AsAccount);

    const txn = await Mina.transaction(user1PublicKey, () => {
      zkApp.releaseFundsRequest(
        user1AsAccount,
        user1AccountWitness,
        UInt64.from(500_000_000)
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
    await doSignUpRequestTxn(user1PrivateKey);
    await doSetActionsRangeTxn();
    const range = getActionsRange();
    await processSignUpAction(range.actions[0]);

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(0));

    const user1AccountWitness = tree.getWitness(
      Poseidon.hash(user1AsAccount.publicKey.toFields())
    );
    await doAddFundsRequestTxn(
      user1PrivateKey,
      user1AsAccount,
      user1AccountWitness,
      UInt64.from(1_000_000_000)
    );

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(1_000_000_000));
    expect(Mina.getBalance(serviceProviderAddress)).toEqual(UInt64.from(1));

    /* Using zkApp.send fails silently without doing nothing, so we don't
     * expect any errors to be thrown by this, we just check later that it
     * actually did nothing.
     */
    const txn1 = await Mina.transaction(zkAppAddress, () => {
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

    expect(Mina.getBalance(zkAppAddress)).toEqual(UInt64.from(1_000_000_000));
    expect(Mina.getBalance(serviceProviderAddress)).toEqual(UInt64.from(1));
  });

  test(`releaseFundsRequest doesn't allow a user to request releasing more
  balance than they have`, async () => {
    await localDeploy();

    await doSignUpRequestTxn(user1PrivateKey);
    await processSignUpAction(user1AsAccount);

    const user1AccountWitness = tree.getWitness(
      Poseidon.hash(user1AsAccount.publicKey.toFields())
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

    await doSignUpRequestTxn(user1PrivateKey);
    await doSignUpRequestTxn(user2PrivateKey);

    await doSetActionsRangeTxn();
    const range1 = getActionsRange();
    await processSignUpAction(range1.actions[0]);
    await processSignUpAction(range1.actions[1]);

    let user1AccountWitness = tree.getWitness(
      Poseidon.hash(user1AsAccount.publicKey.toFields())
    );
    let user2AccountWitness = tree.getWitness(
      Poseidon.hash(user2AsAccount.publicKey.toFields())
    );

    await doAddFundsRequestTxn(
      user1PrivateKey,
      user1AsAccount,
      user1AccountWitness,
      UInt64.from(5_000_000_000)
    );
    await doAddFundsRequestTxn(
      user2PrivateKey,
      user2AsAccount,
      user2AccountWitness,
      UInt64.from(5_000_000_000)
    );

    expect(Mina.getBalance(zkAppAddress)).toEqual(
      UInt64.from(5_000_000_000).mul(2)
    );

    await doSetActionsRangeTxn();
    const range2 = getActionsRange();
    user1AsAccount = await processAddFundsAction(
      range2.actions[0],
      user1AsAccount
    );
    user2AsAccount = await processAddFundsAction(
      range2.actions[1],
      user2AsAccount
    );

    const range3 = getActionsRange();
    user1AccountWitness = tree.getWitness(
      Poseidon.hash(range3.actions[0].publicKey.toFields())
    );
    user2AccountWitness = tree.getWitness(
      Poseidon.hash(range3.actions[1].publicKey.toFields())
    );

    await doReleaseFundsRequestTxn(
      user1PrivateKey,
      user1AsAccount,
      user1AccountWitness,
      UInt64.from(1_000_000_000)
    );
    await doReleaseFundsRequestTxn(
      user2PrivateKey,
      user2AsAccount,
      user2AccountWitness,
      UInt64.from(2_500_000_000)
    );

    const initialRoot = zkApp.accountsRoot.get();
    await doSetActionsRangeTxn();
    const range4 = getActionsRange();
    await processReleaseFundsAction(range4.actions[0], user1AsAccount);
    await processReleaseFundsAction(range4.actions[1], user2AsAccount);

    expect(initialRoot).not.toEqual(zkApp.accountsRoot.get());
    expect(Mina.getBalance(zkAppAddress)).toEqual(
      UInt64.from(5_000_000_000).mul(2).sub(1_000_000_000).sub(2_500_000_000)
    );
    expect(Mina.getBalance(serviceProviderAddress)).toEqual(
      UInt64.from(1).add(1_000_000_000).add(2_500_000_000)
    );
  });

  test(`Trying to process an action not emitted by releaseFundsRequest, with
  processReleaseFundsRequest throws the expected error`, async () => {
    await localDeploy();
    await doSignUpRequestTxn(user1PrivateKey);
    await doSetActionsRangeTxn();
    const range1 = getActionsRange();
    await processSignUpAction(range1.actions[0]);

    let user1AccountWitness = tree.getWitness(
      Poseidon.hash(user1AsAccount.publicKey.toFields())
    );
    await doAddFundsRequestTxn(
      user1PrivateKey,
      user1AsAccount,
      user1AccountWitness,
      UInt64.from(5_000_000_000)
    );

    await doSetActionsRangeTxn();
    const range2 = getActionsRange();

    expect(async () => {
      await processReleaseFundsAction(range2.actions[0], user1AsAccount);
    }).rejects.toThrowError(
      `assert_equal: ${addFundsRequestMethodID} != ${releaseFundsRequestMethodID}`
    );
  });

  test(`if user doesn't signs an addFundsRequest transaction it fails`, async () => {
    await localDeploy();
    await doSignUpRequestTxn(user1PrivateKey);
    await doSetActionsRangeTxn();
    const range1 = getActionsRange();
    await processSignUpAction(range1.actions[0]);

    let user1AccountWitness = tree.getWitness(
      Poseidon.hash(user1AsAccount.publicKey.toFields())
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

  test(`Trying to process an action not emitted by addFundsRequest, with
  processAddFundsRequest throws the expected error`, async () => {
    await localDeploy();
    await doSignUpRequestTxn(user1PrivateKey);
    await doSetActionsRangeTxn();
    const range = getActionsRange();

    expect(async () => {
      await processAddFundsAction(range.actions[0], user1AsAccount);
    }).rejects.toThrowError(
      `assert_equal: ${signUpRequestID} != ${addFundsRequestMethodID}`
    );
  });
});
