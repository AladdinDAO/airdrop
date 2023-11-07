# Airdrop in Aladdin Ecosystem

## install dependency

```
nvm use
yarn install
```

## build merkle proof for token

```bash
yarn start --symbol <token symbol> --address <token address> --csv <csv file>
```

The first row of the csv file should be `address,amount`. The following rows should be comma separated columns. The first column is the address and the second column is the amount of token.