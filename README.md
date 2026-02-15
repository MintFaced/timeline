# Stories We Keep

Preserve the voices you love. We sit with your parents and grandparents, record their stories, and give you a private audio keepsake to treasure forever.

## Setup

1. Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

2. Install dependencies:

```bash
npm install
```

3. Start the server:

```bash
npm start
```

Then open `http://localhost:3000`.

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3000) |
| `STRIPE_SECRET_KEY` | Stripe secret key for payments |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key (sent to frontend) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `CALENDLY_URL` | Your Calendly scheduling link |
| `PRICE_AMOUNT` | Price in cents (default: 29900 = $299) |
| `PRICE_CURRENCY` | Currency code (default: usd) |

## API

- `GET /api/health` — Health check
- `GET /api/config` — Frontend configuration (publishable key, Calendly URL, price)
- `POST /api/checkout` — Create a Stripe Checkout session
- `POST /api/webhook` — Stripe webhook endpoint
