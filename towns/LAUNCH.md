# Launching a new town: the owner's checklist

What only the owner can do (buy, sign up, prove identity), town by town.
Claude does the rest (Railway, settings, testing) once each step is done.
The full reference is RAILWAY.md "New town on Railway"; this is the short
version with each town's own values filled in.

| | Tupelo | Kearney | Medford | The Shoals |
|---|---|---|---|---|
| Slug (`TOWN`) | `tupelo` | `kearney` | `medford` | `shoals` |
| Brand | Tupelo Current | The Crane 308 | The Rogue 541 | Shoals Setlist |
| Domain | tupelocurrent.com | thecrane308.com | therogue541.com | shoalssetlist.com |
| Paid label | Spotlight | Featured | Spotlight | Headliner |
| Newsletter from | `Tupelo Current <news@tupelocurrent.com>` | `The Crane 308 <news@thecrane308.com>` | `The Rogue 541 <news@therogue541.com>` | `Shoals Setlist <news@shoalssetlist.com>` |
| Slack tag | Tupelo | Kearney | Medford | Shoals |

Do one town end to end first (Kearney has the best event feeds), then the
other three.

## 1. Domain (10 min a town)

1. Buy the domain (any registrar; Cloudflare or Porkbun are cheapest to keep).
2. Grab the same name on Instagram and Facebook while you're there.
3. Tell Claude. Claude adds it to Railway and sends you the exact DNS records
   (a `www` CNAME, plus the apex redirect) to paste in.

## 2. Resend: email (5 min a town)

1. resend.com → Domains → Add domain → the town's domain.
2. Paste the DNS records it shows (SPF, DKIM, and the MX record for replies).
3. API Keys → Create API key ("Sending access", that domain only).
4. Webhooks → Add endpoint: `https://www.<domain>/api/email/inbound`, events
   `email.received`, `email.bounced`, `email.complained`.
5. Send Claude the API key and the webhook's signing secret.

## 3. Stripe: payments (10 min a town)

1. dashboard.stripe.com → account menu (top left) → **New account**, named
   after the brand, on the same LLC, EIN and bank account as The Vic 361.
2. Settings → Business → Public details: business name (the brand),
   statement descriptor (e.g. `TUPELO CURRENT`), logo (from
   `towns/<slug>/public/logo-512.png`).
3. Tell Claude which account it is. Claude sets up the webhook and keys.

## 4. Cloudflare Turnstile: spam protection on forms (2 minutes total)

dash.cloudflare.com → Turnstile → your existing widget → Settings → add
`www.tupelocurrent.com`, `www.thecrane308.com`, `www.therogue541.com`,
`www.shoalssetlist.com`. (Or one new widget for all four; send Claude its
site key and secret key.)

## 5. Facebook and Instagram (15 min a town)

1. Create a Facebook Page named after the brand (category: Media/News
   Company), and an Instagram professional account linked to it.
2. In Meta Business Suite, add both to your business. For ads, add an ad
   account for the town.
3. Tell Claude when they exist; Claude walks you through the page token.

## 6. Mailing address (once)

Every newsletter must show a postal address. A PO box or a registered
mailbox works, and one can serve all towns. Send Claude the address.

## 7. GitHub Environment (5 min a town; Claude gives you each value)

GitHub → the repo → Settings → Environments → **New environment** named the
town's slug (`kearney`, …). Add the variables and secrets Claude sends you:
`SITE_URL`, `SLACK_TOWN_TAG`, the cron secrets, and the Meta page and
Instagram ids and tokens. Victoria keeps using the repo-level settings.

## After that (Claude)

The town's workflow jobs pointed at its Environment, its Railway service and database, every Railway variable, domain, Stripe
webhook, HQ entry, `"workflows": true` for the town, the first collect, the
launch check (`scripts/launch_check.py --town <slug>`), a test newsletter to
the test address, a test-mode checkout, and a check that Victoria is
unchanged.
