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
} from 'snarkyjs';

import { Account } from './Account.js';

await isReady;

export class AccountManagement extends SmartContract {
  reducer = Reducer({ actionType: Account });

  @state(Field) startOfAllActions = State<Field>();
  @state(Field) accountNumber = State<Field>();

  deploy(args: DeployArgs) {
    super.deploy(args);
    this.setPermissions({
      ...Permissions.default(),
    });
    this.startOfAllActions.set(Reducer.initialActionsHash);
    this.accountNumber.set(Field(0));
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
    
    // Update current available account number
    this.accountNumber.set(accountNumber.add(Field(1)));
  }
}
