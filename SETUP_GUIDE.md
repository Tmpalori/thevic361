# The Vic 361 — Setup Guide

Follow these steps to get everything running.

---

## 1. Create the GitHub Repository

1. Go to [github.com/new](https://github.com/new)
2. Name it `thevic361` (or whatever you prefer)
3. Set to **Public** (required for free GitHub Pages)
4. Click **Create repository**
5. Push this folder:

```bash
cd vic361-collector
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/thevic361.git
git push -u origin main
```

---

## 2. Enable GitHub Pages

1. Go to your repo → **Settings** → **Pages**
2. Source: **Deploy from a branch**
3. Branch: `main`, folder: `/docs`
4. Click **Save**
5. Your site will be live at: `https://YOUR_USERNAME.github.io/thevic361/`

---

## 3. Point Your Domain (thevic361.com)

### Option A: Custom domain via GitHub Pages

1. In repo **Settings → Pages → Custom domain**, enter `thevic361.com`
2. Check "Enforce HTTPS"
3. At your domain registrar (wherever you bought thevic361.com), add these DNS records:

| Type | Name | Value |
|---|---|---|
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| CNAME | www | YOUR_USERNAME.github.io |

4. Wait 10-30 minutes for DNS to propagate
5. GitHub will auto-provision an SSL certificate

### Option B: Keep using the Perplexity-hosted version

The site is currently live at the URL I deployed earlier. You can point your domain to that instead using a CNAME redirect. But GitHub Pages is recommended for the automation pipeline.

---

## 4. Set Up the OpenAI API Key (Optional, ~$1-2/month)

The AI cleanup step polishes event descriptions and deduplicates more intelligently. It's optional — the collector works fine without it.

1. Get an API key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Add it as a GitHub Secret:
   - Repo → **Settings** → **Secrets and variables** → **Actions**
   - Click **New repository secret**
   - Name: `OPENAI_API_KEY`
   - Value: your API key

---

## 5. Enable GitHub Actions

1. Go to repo → **Actions** tab
2. You should see the "Collect Events" workflow
3. Click **Enable** if prompted
4. To test: click **Run workflow** → **Run workflow** (manual trigger)
5. It will run automatically every day at 6:00 AM Central

---

## 6. Set Up the Email Sender

The Sunday digest emails are sent via Gmail SMTP using an [App Password](https://myaccount.google.com/apppasswords).

1. Generate a Gmail App Password for `tristen.m.palori@gmail.com`
2. Add as GitHub Secrets:
   - `SMTP_EMAIL` = `tristen.m.palori@gmail.com`
   - `SMTP_PASSWORD` = the App Password (16-char string, no spaces)

The weekly digest workflow uses these to email you the candidates each Sunday.

---

## 7. Set Up Beehiiv (Email Collection)

1. Sign up at [beehiiv.com](https://www.beehiiv.com) (free tier: 2,500 subscribers)
2. Create a publication named "The Vic 361"
3. Set up your custom domain (`newsletter.thevic361.com` or similar)
4. Get your Beehiiv embed code or subscribe URL
5. Update the subscribe link in `docs/index.html` (search for `#subscribe`)

Beehiiv free tier includes:
- Up to 2,500 subscribers
- Unlimited sends
- Custom domain support
- Basic analytics

---

## Monthly Costs

| Service | Cost |
|---|---|
| GitHub Pages hosting | Free |
| GitHub Actions (2,000 min/month) | Free |
| Domain (thevic361.com) | ~$1/month ($12/year) |
| OpenAI API (optional) | ~$1-2/month |
| Beehiiv free tier | Free |
| **Total** | **~$2-3/month** |

---

## Architecture

```
Daily at 6 AM Central:
┌─────────────────────┐
│  GitHub Actions      │
│  runs collector      │──→ events.json updated
└─────────────────────┘
         │
         ▼
┌─────────────────────┐
│  victoriatx.gov     │
│  Chamber of Commerce│──→ Raw events fetched
│  local_events.yaml  │
└─────────────────────┘
         │
         ▼
┌─────────────────────┐
│  OpenAI (optional)  │──→ Cleanup + dedup
└─────────────────────┘
         │
         ▼
┌─────────────────────┐
│  docs/events.json   │──→ GitHub Pages serves
│  thevic361.com      │    the website
└─────────────────────┘
```
