import { Field, Poseidon, PublicKey, Struct, UInt64, UInt32 } from 'snarkyjs';

export class Account extends Struct({
  publicKey: PublicKey,
  balance: UInt64,
  actionOrigin: UInt32,
  released: UInt64,
}) {
  hash(): Field {
    return Poseidon.hash(
      this.publicKey
        .toFields()
        .concat(this.balance.toFields())
        .concat(this.actionOrigin.toFields())
        .concat(this.released.toFields())
    );
  }
}
