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
  Bool,
  AccountUpdate,
  Circuit,
  UInt64,
  UInt32,
  MerkleTree,
} from 'snarkyjs';

import {
  Account,
  stateType,
  AccountWitness,
  initialBalance,
} from './Account.js';

await isReady;

export const signUpMethodID = UInt32.from(1);
export const releaseFundsMethodID = UInt32.from(2);
const tree = new MerkleTree(21);
export const root = tree.getRoot();

export class AccountManagement extends SmartContract {
  reducer = Reducer({ actionType: Account });

  @state(Field) startOfAllActions = State<Field>();
  @state(Field) accountNumber = State<Field>();
  @state(Field) numberOfPendingActions = State<Field>();
  @state(Field) actionTurn = State<Field>();
  @state(Field) startOfActionsRange = State<Field>();
  @state(Field) endOfActionsRange = State<Field>();
  @state(Field) accountsRoot = State<Field>();

  deploy(args: DeployArgs) {
    super.deploy(args);
    this.setPermissions({
      ...Permissions.default(),
      send: Permissions.proof(),
    });
    this.startOfAllActions.set(Reducer.initialActionsHash);
    this.accountNumber.set(Field(1));
    this.numberOfPendingActions.set(Field(0));
    this.actionTurn.set(Field(0));
    this.startOfActionsRange.set(Reducer.initialActionsHash);
    this.endOfActionsRange.set(Reducer.initialActionsHash);
    this.accountsRoot.set(root);
  }

  @method requestSignUp(publicKey: PublicKey) {
    /* Require signature of the account requesting signing-up,
     * so only the user themselves can request to sign-up. User
     * also sends 5 MINA to be able to start using the service
     * immediately after signing-up (This allows sevice providers
     * to see that the user has funds, so they have the
     * incentive to serve the user).
     */

    let accountUpdate = AccountUpdate.create(publicKey);
    accountUpdate.requireSignature();
    accountUpdate.send({ to: this.address, amount: initialBalance });

    /* Get the current available account number to assign to
     * the user.
     */
    const accountNumber = this.accountNumber.get();
    this.accountNumber.assertEquals(accountNumber);

    /* Check all actions to see if the public key isn't
     * already registered. If not, emit action representing
     * the sign-up request.
     */
    const startOfAllActions = this.startOfAllActions.get();
    this.startOfAllActions.assertEquals(startOfAllActions);

    const actions = this.reducer.getActions({
      fromActionHash: startOfAllActions,
    });

    let { state: exists } = this.reducer.reduce(
      actions,
      Bool,
      (state: Bool, action: { publicKey: PublicKey }) => {
        return action.publicKey.equals(publicKey).or(state);
      },
      { state: Bool(false), actionsHash: startOfAllActions }
    );

    exists.assertEquals(Bool(false));

    let account = new Account({
      publicKey: publicKey,
      accountNumber: accountNumber,
      balance: initialBalance,
      actionOrigin: UInt32.from(1),
    });
    this.reducer.dispatch(account);

    // Update current available account number.
    this.accountNumber.set(accountNumber.add(Field(1)));
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
      (state: Field) => {
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

  @method processSignUpRequestAction(accountWitness: AccountWitness) {
    // Validate that the provided witness comes from the tree we committed to
    const accountsRoot = this.accountsRoot.get();
    this.accountsRoot.assertEquals(accountsRoot);
    accountWitness.calculateRoot(Field(0)).assertEquals(accountsRoot);

    /* Get the action to be processed and associated data with this operation.
     * Then check that the action was emitted by the corresponding method.
     */
    const actionWithMetadata = this.getCurrentAction();
    const action = actionWithMetadata.action;
    action.actionOrigin.assertEquals(signUpMethodID);

    /* Validate that the account was registered using the account number
     * as the index for the merkle tree.
     */
    accountWitness.calculateIndex().assertEquals(action.accountNumber);

    /* Convert action into its proper Account type, so its methods
     * become available.
     */
    let typedAction = new Account(action);

    /* Update the merkle tree root, so it includes the new registered
     * account.
     */
    this.accountsRoot.set(accountWitness.calculateRoot(typedAction.hash()));

    /* Advance to the turn of the next action to be processed, and decrease the
     * number of pending actions to account for the one we processed.
     */
    this.actionTurn.set(actionWithMetadata.actionTurn.add(1));

    const numberOfPendingActions = this.numberOfPendingActions.get();
    this.numberOfPendingActions.assertEquals(numberOfPendingActions);
    this.numberOfPendingActions.set(numberOfPendingActions.sub(Field(1)));
  }

  @method releaseFunds(from: PublicKey, to: PublicKey, amount: UInt64) {
    AccountUpdate.create(from).requireSignature();
    this.send({ to, amount });

    const action = new Account({
      publicKey: from,
      accountNumber: Field(0),
      balance: amount,
      actionOrigin: UInt32.from(releaseFundsMethodID),
    });

    this.reducer.dispatch(action);
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
      stateType,
      (state, action) => {
        let isCurrentAction = index.equals(actionTurn);
        index = index.add(1);
        return {
          publicKey: Circuit.if(
            isCurrentAction,
            action.publicKey,
            state.publicKey
          ),
          accountNumber: Circuit.if(
            isCurrentAction,
            action.accountNumber,
            state.accountNumber
          ),
          balance: Circuit.if(isCurrentAction, action.balance, state.balance),
          actionOrigin: Circuit.if(
            isCurrentAction,
            action.actionOrigin,
            state.actionOrigin
          ),
        };
      },
      {
        state: {
          publicKey: PublicKey.empty(),
          accountNumber: Field(0),
          balance: UInt64.from(0),
          actionOrigin: UInt32.from(0),
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
