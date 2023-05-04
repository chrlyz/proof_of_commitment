import {
  Field,
  SmartContract,
  method,
  DeployArgs,
  Permissions,
  isReady,
  Reducer,
  PublicKey,
  State,
  state,
  AccountUpdate,
  Circuit,
  UInt64,
  UInt32,
  MerkleMap,
  MerkleMapWitness,
} from 'snarkyjs';

import { Account } from './Account.js';

await isReady;

export const signUpRequestID = UInt32.from(0);
export const addFundsRequestID = UInt32.from(1);
export const releaseFundsRequestID = UInt32.from(2);
const tree = new MerkleMap();
export const root = tree.getRoot();

/* When deploying the contract, replace serviceProviderAddress with the address
 * of a key you control.
 */
export const serviceProviderAddress = PublicKey.fromBase58(
  'B62qjA4aVsTqjAEmZHrDRUfWgQSYY2Ww6jzfog3YezpNDDG3VAVsArH'
);

export class AccountManagement extends SmartContract {
  reducer = Reducer({ actionType: Account });

  @state(Field) numberOfPendingActions = State<Field>();
  @state(Field) actionTurn = State<Field>();
  @state(Field) startOfActionsRange = State<Field>();
  @state(Field) endOfActionsRange = State<Field>();
  @state(Field) accountsRoot = State<Field>();

  deploy(args: DeployArgs) {
    super.deploy(args);
    this.account.permissions.set({
      ...Permissions.default(),
      send: Permissions.proof(),
    });
    this.numberOfPendingActions.set(Field(0));
    this.actionTurn.set(Field(0));
    this.startOfActionsRange.set(Reducer.initialActionsHash);
    this.endOfActionsRange.set(Reducer.initialActionsHash);
    this.accountsRoot.set(root);
  }

  @method signUpRequest(
    publicKey: PublicKey,
    accountWitness: MerkleMapWitness
  ) {
    /* Validate that the account hasn't been registered, and that the provided
     * witness comes from the tree we are committed to on-chain.
     */
    const accountsRoot = this.accountsRoot.get();
    this.accountsRoot.assertEquals(accountsRoot);
    accountsRoot.assertEquals(accountWitness.computeRootAndKey(Field(0))[0]);

    /* Emit a signUpRequest action with the public key of the user (require
     * the signature of the user to sign-up, so only the user can register
     * their account).
     */

    const accountUpdate = AccountUpdate.create(publicKey);
    accountUpdate.requireSignature();

    const initialAccountState = new Account({
      publicKey: publicKey,
      balance: UInt64.from(0),
      actionOrigin: signUpRequestID,
      released: UInt64.from(0),
    });

    this.reducer.dispatch(initialAccountState);
  }

  @method addFundsRequest(
    accountState: Account,
    accountWitness: MerkleMapWitness,
    amount: UInt64
  ) {
    // Validate that the account state is within our on-chain tree.
    const accountsRoot = this.accountsRoot.get();
    this.accountsRoot.assertEquals(accountsRoot);
    accountsRoot.assertEquals(
      accountWitness.computeRootAndKey(accountState.hash())[0]
    );

    // Require the signature of the user.
    let accountUpdate = AccountUpdate.create(accountState.publicKey);
    accountUpdate.send({ to: this.address, amount: amount });

    /* Assign proper actionOrigin in a new account state, and the new balance
     * after adding the funds.
     */
    let newAccountState = new Account(accountState);
    newAccountState.actionOrigin = addFundsRequestID;
    newAccountState.balance = accountState.balance.add(amount);

    // Dispatch the new state of the account.
    this.reducer.dispatch(newAccountState);
  }

  @method releaseFundsRequest(
    accountState: Account,
    accountWitness: MerkleMapWitness,
    amount: UInt64
  ) {
    // Validate that the account state is within our on-chain tree.
    const accountsRoot = this.accountsRoot.get();
    this.accountsRoot.assertEquals(accountsRoot);
    accountsRoot.assertEquals(
      accountWitness.computeRootAndKey(accountState.hash())[0]
    );

    // Make sure user has enough funds to release.
    amount.assertLte(accountState.balance);

    // Require the signature of the user.
    AccountUpdate.create(accountState.publicKey).requireSignature();

    /* Assign proper actionOrigin in a new account state, and the amount of
     * funds to be released.
     */
    let newAccountState = new Account(accountState);
    newAccountState.actionOrigin = releaseFundsRequestID;
    newAccountState.released = amount;

    // Dispatch the new state of the account.
    this.reducer.dispatch(newAccountState);
  }

  @method setRangeOfActionsToBeProcessed() {
    /* Get number of pending actions and make sure that there are no
     * pending actions to be processed.
     */
    const numberOfPendingActions = this.numberOfPendingActions.get();
    this.numberOfPendingActions.assertEquals(numberOfPendingActions);
    this.numberOfPendingActions.assertEquals(Field(0));

    // Reset index for processing actions within the range.
    this.actionTurn.set(Field(0));

    /* Get the action hash of the last action that was processed, and
     * use it as the starting point of the next range of actions
     * to be processed. Then count all the actions within the new
     * range, and get the action hash of the last action for the new
     * range.
     */
    const endOfActionsRange = this.endOfActionsRange.get();
    this.endOfActionsRange.assertEquals(endOfActionsRange);

    const actions = this.reducer.getActions({
      fromActionHash: endOfActionsRange,
    });

    const {
      state: newNumberOfPendingActions,
      actionsHash: newEndOfActionsRange,
    } = this.reducer.reduce(
      actions,
      Field,
      (state) => {
        return state.add(Field(1));
      },
      { state: Field(0), actionsHash: endOfActionsRange }
    );

    // Set number of pending actions within the new range.
    this.numberOfPendingActions.set(newNumberOfPendingActions);

    /* Finally set the action hash of the last processed action as the
     * start of the new range, and the action hash of the last action for
     * the new range.
     */
    const startOfActionsRange = this.startOfActionsRange.get();
    this.startOfActionsRange.assertEquals(startOfActionsRange);

    this.startOfActionsRange.set(endOfActionsRange);
    this.endOfActionsRange.set(newEndOfActionsRange);
  }

  @method processSignUpRequest(accountWitness: MerkleMapWitness) {
    /* Check if the account hasn't been registered, and that the provided
     * witness comes from the tree we are committed to on-chain.
     */
    const accountsRoot = this.accountsRoot.get();
    this.accountsRoot.assertEquals(accountsRoot);
    const isSignedUp = accountsRoot
      .equals(accountWitness.computeRootAndKey(Field(0))[0])
      .not();

    /* Get the action to be processed, and associated data with this operation.
     * Then check that the action was emitted by the corresponding method.
     */
    const actionWithMetadata = this.getCurrentAction();
    const action = actionWithMetadata.action;
    action.actionOrigin.assertEquals(signUpRequestID);

    const initialAccountState = new Account(action);

    /* Update the merkle tree root with the correct account state (keeping the
     * current root value if the user already signed-up, or updating with the
     * new root value if the user hasn't signed-up).
     */
    const newRoot = accountWitness.computeRootAndKey(
      initialAccountState.hash()
    )[0];
    const chosenRoot = Circuit.if(isSignedUp, accountsRoot, newRoot);
    this.accountsRoot.set(chosenRoot);

    /* Advance to the turn of the next action to be processed, and decrease the
     * number of pending actions to account for the one we processed.
     */
    this.actionTurn.set(actionWithMetadata.actionTurn.add(1));

    const numberOfPendingActions = this.numberOfPendingActions.get();
    this.numberOfPendingActions.assertEquals(numberOfPendingActions);
    this.numberOfPendingActions.set(numberOfPendingActions.sub(Field(1)));
  }

  @method processAddFundsRequest(
    accountState: Account,
    accountWitness: MerkleMapWitness
  ) {
    /* Validate that the provided witness comes from the tree we are
     * committed to on-chain.
     */
    const accountsRoot = this.accountsRoot.get();
    this.accountsRoot.assertEquals(accountsRoot);
    accountsRoot.assertEquals(
      accountWitness.computeRootAndKey(accountState.hash())[0]
    );

    /* Get the action to be processed, and associated data with this operation.
     * Then check that the action was emitted by the corresponding method.
     */
    const actionWithMetadata = this.getCurrentAction();
    const action = actionWithMetadata.action;
    action.actionOrigin.assertEquals(addFundsRequestID);

    /* Assign new balance after substracting the released amount, and reset
     * released amount.
     */
    let newAccountState = new Account(action);

    // Update the merkle tree root with the new account state.
    this.accountsRoot.set(
      accountWitness.computeRootAndKey(newAccountState.hash())[0]
    );

    /* Advance to the turn of the next action to be processed, and decrease the
     * number of pending actions to account for the one we processed.
     */
    this.actionTurn.set(actionWithMetadata.actionTurn.add(1));

    const numberOfPendingActions = this.numberOfPendingActions.get();
    this.numberOfPendingActions.assertEquals(numberOfPendingActions);
    this.numberOfPendingActions.set(numberOfPendingActions.sub(Field(1)));
  }

  @method processReleaseFundsRequest(
    accountState: Account,
    accountWitness: MerkleMapWitness
  ) {
    /* Validate that the provided witness comes from the tree we are
     * committed to on-chain.
     */
    const accountsRoot = this.accountsRoot.get();
    this.accountsRoot.assertEquals(accountsRoot);
    accountsRoot.assertEquals(
      accountWitness.computeRootAndKey(accountState.hash())[0]
    );

    /* Get the action to be processed, and associated data with this operation.
     * Then check that the action was emitted by the corresponding method.
     */
    const actionWithMetadata = this.getCurrentAction();
    const action = actionWithMetadata.action;
    action.actionOrigin.assertEquals(releaseFundsRequestID);

    // Send the released funds to service provider.
    this.send({ to: serviceProviderAddress, amount: action.released });

    /* Assign new balance after substracting the released amount, and reset
     * released amount.
     */
    let newAccountState = new Account(action);
    newAccountState.balance = action.balance.sub(action.released);
    newAccountState.released = UInt64.from(0);

    // Update the merkle tree root with the new account state.
    this.accountsRoot.set(
      accountWitness.computeRootAndKey(newAccountState.hash())[0]
    );

    /* Advance to the turn of the next action to be processed, and decrease the
     * number of pending actions to account for the one we processed.
     */
    this.actionTurn.set(actionWithMetadata.actionTurn.add(1));

    const numberOfPendingActions = this.numberOfPendingActions.get();
    this.numberOfPendingActions.assertEquals(numberOfPendingActions);
    this.numberOfPendingActions.set(numberOfPendingActions.sub(Field(1)));
  }

  getCurrentAction() {
    /* Traverse current range of pending actions, to recover
     * the current action that needs to be processed.
     */
    const startOfActionsRange = this.startOfActionsRange.get();
    this.startOfActionsRange.assertEquals(startOfActionsRange);

    const endOfActionsRange = this.endOfActionsRange.get();
    this.endOfActionsRange.assertEquals(endOfActionsRange);

    const actionTurn = this.actionTurn.get();
    this.actionTurn.assertEquals(actionTurn);

    const actions = this.reducer.getActions({
      fromActionHash: startOfActionsRange,
      endActionHash: endOfActionsRange,
    });

    let index = Field(0);
    const { state: action } = this.reducer.reduce(
      actions,
      Account,
      (state, action) => {
        let isCurrentAction = index.equals(actionTurn);
        index = index.add(1);
        return {
          publicKey: Circuit.if(
            isCurrentAction,
            action.publicKey,
            state.publicKey
          ),
          balance: Circuit.if(isCurrentAction, action.balance, state.balance),
          actionOrigin: Circuit.if(
            isCurrentAction,
            action.actionOrigin,
            state.actionOrigin
          ),
          released: Circuit.if(
            isCurrentAction,
            action.released,
            state.released
          ),
        };
      },
      {
        state: {
          publicKey: PublicKey.empty(),
          balance: UInt64.from(0),
          actionOrigin: UInt32.from(0),
          released: UInt64.from(0),
        },
        actionsHash: startOfActionsRange,
      }
    );

    return {
      action: action,
      startOfActionsRange: startOfActionsRange,
      endOfActionsRange: endOfActionsRange,
      actionTurn: actionTurn,
    };
  }
}
