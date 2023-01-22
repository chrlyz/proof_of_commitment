import {
  Field,
  isReady,
  Poseidon,
  PublicKey,
  Struct,
  UInt64,
  UInt32,
} from 'snarkyjs';

await isReady;

export class Account extends Struct({
  publicKey: PublicKey,
  accountNumber: Field,
  balance: UInt64,
  actionOrigin: UInt32,
  provider: PublicKey,
  released: UInt64,
}) {
  hash(): Field {
    return Poseidon.hash(
      this.publicKey
        .toFields()
        .concat(this.accountNumber.toFields())
        .concat(this.balance.toFields())
        .concat(this.actionOrigin.toFields())
        .concat(this.provider.toFields())
        .concat(this.released.toFields())
    );
  }
}
