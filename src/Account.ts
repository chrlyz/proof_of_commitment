import {
  Field,
  isReady,
  Poseidon,
  PublicKey,
  Struct,
  UInt64,
  MerkleWitness,
  UInt32,
} from 'snarkyjs';

await isReady;

export const initialBalance = UInt64.from(5_000_000_000);
export class AccountWitness extends MerkleWitness(21) {}

export class Account extends Struct({
  publicKey: PublicKey,
  accountNumber: Field,
  balance: UInt64,
  actionOrigin: UInt32,
}) {
  hash(): Field {
    return Poseidon.hash(
      this.publicKey
        .toFields()
        .concat(this.accountNumber.toFields())
        .concat(this.balance.toFields())
        .concat(this.actionOrigin.toFields())
    );
  }
}

export class AccountShape extends Struct({
  publicKey: PublicKey,
  accountNumber: Field,
  balance: UInt64,
  actionOrigin: UInt32,
}) {}
