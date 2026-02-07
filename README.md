# Artist Timeline (Allium + Ethereum)

Minimal web app that builds a left-to-right timeline of milestone events for an Ethereum artist wallet (or `.eth`
name), focused on the most recent 30 days.

## Milestones

- Biggest sale day
- New smart contracts launched
- Token sales where the wallet sold art it created
- Token sales where the wallet sold art it previously bought

## Setup

1. Copy `.env.example` to `.env`.
2. Add your `ALLIUM_API_KEY` to `.env`.
3. Start the app:

```bash
npm run start
```

Then open `http://localhost:3000`.

## API

- `GET /api/timeline?artist=Name&chain=ethereum&wallet=mintface.eth`
- `GET /api/timeline?artist=Name&chain=ethereum&wallet=0x...&contracts=0x...,0x...`
- `GET /api/health`

## Notes

- Allium API key is only used server-side.
- ENS names are resolved server-side before querying Allium.
- Contract creation timestamps depend on fields returned by the Allium contracts endpoint.
- Wallet timelines are limited to the last 30 days, with additional lookback for token provenance.
