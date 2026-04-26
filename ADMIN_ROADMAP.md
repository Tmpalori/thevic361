# The Vic 361 Admin Roadmap

## Product Direction

The Vic 361 is moving toward a weekly curated Victoria events workflow. Each week, candidate events are collected, reviewed in an admin interface, and published only after admin approval. Looking ahead, public-facing event and sponsor submissions will be supported, but they will enter a review queue rather than publishing directly to the live site or newsletter.

## Completed Rebuild PRs

- **PR #15** — Weekly cadence foundation; daily approval infrastructure removed.
- **PR #16** — Google Maps venue discovery plus the new venues files.
- **PR #17** — Instagram posts pipeline behind `IG_POSTS_ENABLED=1`.
- **PR #18** — Venue-grounded Sonar prompt redesign.
- **PR #19** — Admin publishing view.
- **PR #20** — Fixed admin preview mode / URI-too-long issue.

## Near-Term Roadmap

- **PR #21** — Active-week filter; default to the next Mon–Sun publishing week.
- **PR #22** — Custom event editor in admin.
- **PR #23** — Duplicate review and handling improvements.
- **PR #24** — Pre-publish validation checklist.

## Public Submission Workflow

- Public "submit an event" page.
- Submission storage.
- Admin review queue for incoming submissions.
- Approve, reject, mark duplicate, or edit before approving.

## Sponsor Workflow

- Public sponsor / advertise request page.
- Sponsor manager in the admin interface.
- Beehiiv sponsor blocks in the newsletter.
- Site sponsor placements.

## Reliability and Automation

- Admin tests running in CI.
- Clearer candidate date-window metadata.
- Optional later: admin-triggered Weekly Collect.

## Newsletter and Content Polish

- Better Beehiiv output.
- Subject line and preheader ideas.
- Event detail and share pages.
- Analytics tracking.

## Hard Guardrails

- Public submissions never publish directly — they always enter the review queue.
- Keep the weekly cadence and admin review loop intact.
- Keep scraper, Sonar, and Instagram changes separate from admin UX PRs unless explicitly scoped together.
- Keep sponsors and ads separate from event-picking PRs until the sponsor workflow PRs land.

## Next-Session Resume Prompt

```
We're continuing work on The Vic 361 admin/product roadmap. The roadmap lives at ADMIN_ROADMAP.md on main. Completed: PRs #15–#20 (weekly cadence, venue discovery, IG pipeline, Sonar redesign, admin publishing view, admin preview fix). Next up is PR #21 (active-week filter defaulting to next Mon–Sun), then PR #22 (custom event editor), PR #23 (duplicate handling), PR #24 (pre-publish validation checklist). After that: public event submission workflow (submit page → storage → admin review queue with approve/reject/duplicate/edit), then sponsor workflow (public request page → sponsor manager → Beehiiv sponsor blocks → site placements). Guardrails: public submissions never publish directly; keep weekly cadence and admin review loop; keep scraper/Sonar/IG work out of admin UX PRs; keep sponsors out of event-picking PRs. Please pick up from the next unfinished roadmap item and confirm before changing scope.
```
