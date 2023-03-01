# Mina zkApp: Swepr Contracts

Proof of Concept of a Mina smart contract that allows the user of a service
to deposit funds in the contract, so the service provider is able to verify
that the user has committed funds that can only be accessed by the service
provider after the user approves it.

This way the service provider has an incentive to service the user, since
the user has funds in the contract, while the user knows that the service
provider can't simply run away with the funds without providing the service,
establishing a relationship of aligned incentives, without the need for paying
for a Mina transaction and waiting for it to finalize every time the user and
the service provider interact.

## How to build

```sh
npm run build
```

## How to run tests

```sh
npm run test
npm run testw # watch mode
```

## How to run coverage

```sh
npm run coverage
```
