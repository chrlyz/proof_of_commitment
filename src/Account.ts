import { Field,
  Poseidon,
  PublicKey,
  Struct } from 'snarkyjs';

export class Account extends Struct({

  publicKey: PublicKey,
  accountNumber: Field

}) {

  static new(publicKey: PublicKey,
             accountNumber: Field): Account {

      return new Account({
        publicKey: publicKey,
        accountNumber: accountNumber
      });

  }

  hash(): Field {

    return Poseidon.hash(this.publicKey.toFields()
          .concat(this.accountNumber.toFields()));

  }
}
