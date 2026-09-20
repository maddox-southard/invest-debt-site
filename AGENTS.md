# invest-debt-site

investvsdebt.com: a one-page Next.js calculator answering "should my extra
cash pay down debt or be invested?" It exists because the honest answer is
arithmetic most people never see: amortize the debt, compound the
contributions, chart both with the milestones named. `src/app/guides/` exists
for search and LLM discovery and is deliberately off the nav.

## Optimize for

A correct, explainable answer the user trusts, then clarity over features.
Every number on the page should be reproducible by hand from the inputs.

## Principles

- The math is the product. It lives in `src/lib/calculations/` (amortization,
  growth, comparison) and `src/lib/recommendation.ts` (the decision rule);
  components only display. Assumptions are listed atop `comparison.ts`.
- Every assumption is visible to the user, in the inputs or the copy, never
  only in code.
- Education, never advice. The disclaimer in `OptimalDecisionDisplay.tsx`
  stays; copy explains trade-offs rather than telling anyone what to do.
- Ship small through a PR with the reasoning in the description; Vercel
  (project `invest-vs-debt`) deploys `main`, and `npm run deploy` is a Railway
  leftover. Leave a comment at any gotcha you hit.

## The edge of the sandbox

Changing a default rate, a horizon, or the model itself needs a human review:
PR it with before and after, and wait. Nothing here may claim to be financial
advice or promise a return. Spending money, DNS, the Vercel project, and what
the GitHub token may do are Maddox's call: prepare it, then ask in #agents.
Credentials come from the Infisical vault through `scripts/vault.mjs`
(`env:pull`, `with-secrets`, `env:notes`) and the environment, never from an
interactive login.
