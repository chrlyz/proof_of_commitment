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
  MerkleWitness,
  Circuit,
  provable,
} from 'snarkyjs';

import { Account } from './Account.js';

await isReady;

export class AccountWitness extends MerkleWitness(21) {}

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
    });
    this.startOfAllActions.set(Reducer.initialActionsHash);
    this.accountNumber.set(Field(0));
    this.numberOfPendingActions.set(Field(0));
    this.actionTurn.set(Field(0));
    this.startOfActionsRange.set(Reducer.initialActionsHash);
    this.endOfActionsRange.set(Reducer.initialActionsHash);
    this.accountsRoot.set(Field(0));
  }

  @method requestSignUp(publicKey: PublicKey) {
    /*Require signature of the account requesting signing-up,
     *so only the user themselves can request to sign-up.
     */

    let accountUpdate = AccountUpdate.create(publicKey);
    accountUpdate.requireSignature();

    /* Get the current available account number to assign to
     * the user if a successful sign-up request is emitted. */

    const accountNumber = this.accountNumber.get();
    this.accountNumber.assertEquals(accountNumber);

    /* Check all actions to see if the public key isn't
     * already registered. If not, emit action representing
     * the request.
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

    let account = Account.new(publicKey, accountNumber);
    this.reducer.dispatch(account);

    // Update current available account number.
    this.accountNumber.set(accountNumber.add(Field(1)));
  }

  @method setRangeOfActionsToBeProcessed() {
    /* Get number of pending actions and make sure that there are no
     * pending actions to be processed. */

    const numberOfPendingActions = this.numberOfPendingActions.get();
    this.numberOfPendingActions.assertEquals(numberOfPendingActions);
    this.numberOfPendingActions.assertEquals(Field(0));

    // Reset index for processing actions within the range.
    this.actionTurn.set(Field(0));

    /* Get the action hash of the last action that was processed, and
     * use it as the starting point of the next range of actions
     * to be processed. Then count all the actions within the new
     * range, and get the action hash of the last action for the new
     * range. */

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
     * the new range. */

    const startOfActionsRange = this.startOfActionsRange.get();
    this.startOfActionsRange.assertEquals(startOfActionsRange);

    this.startOfActionsRange.set(endOfActionsRange);
    this.endOfActionsRange.set(newEndOfActionsRange);
  }

  @method processSignUpRequestAction(accountWitness: AccountWitness) {
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

    const stateType = provable({ index: Field, accountsRoot: Field });

    const { state: processedAction } = this.reducer.reduce(
      actions,
      stateType,
      (state, action) => {
        let isCurrentAction = state.index.equals(actionTurn);
        let typedAction = new Account({
          publicKey: action.publicKey,
          accountNumber: action.accountNumber,
        });
        let newAccountsRoot = accountWitness.calculateRoot(typedAction.hash());

        return {
          index: state.index.add(1),
          accountsRoot: state.accountsRoot.add(
            Circuit.if(isCurrentAction, newAccountsRoot, state.accountsRoot)
          ),
        };
      },
      {
        state: { index: Field(0), accountsRoot: Field(0) },
        actionsHash: startOfActionsRange,
      }
    );

    this.actionTurn.set(actionTurn.add(1));

    this.accountsRoot.set(processedAction.accountsRoot);

    const numberOfPendingActions = this.numberOfPendingActions.get();
    this.numberOfPendingActions.assertEquals(numberOfPendingActions);
    this.numberOfPendingActions.set(numberOfPendingActions.sub(Field(1)));
  }
}
