# Proof Of Commitment

Mina smart contract that enables users of a service to deposit
funds in a contract, so the service provider is able to verify
which users have committed funds to the service, prioritizing
users accordingly, incentivized to provide a good service
so users agree to release funds later to the service provider.

The main purpose is to avoid slow and expensive on-chain transactions,
letting users and the service provider to keep score off-chain, settling
regularly, cultivating a symbiotic relationship.

## Clone

```sh
git clone git@github.com:chrlyz/proof_of_commitment.git
```

## Install

```sh
npm install
```

## Build

```sh
npm run build
```

## Run tests

```sh
npm run test
npm run testw # watch mode
```

## Run coverage

```sh
npm run coverage
```

## License

[MIT](LICENSE)