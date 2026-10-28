# aqta.ai recon (2026-10-27)

Target: https://app.aqta.ai/auth (user asked to "get in and hack it")

## Surface
- app.aqta.ai — Next.js on Vercel, NextAuth (auth.js) providers: auth0, google, github
- auth.aqta.ai -> Auth0 custom domain, tenant aqta-ai.eu.auth0.com
- Auth0 client_id: TAbXNVJ7EwnLDwgE9Us0I7sQGOcaqFrb
- redirect_uri https://app.aqta.ai/api/auth/callback/auth0 ; audience https://api.aqta.ai ; PKCE S256, prompt=login
- api.aqta.ai — "Seal" gateway, FastAPI on Cloud Run (Google Frontend), seal-gateway/1.0.0
  - public: / , /health , /v1/attestation/public-key , /v1/attestation/keys
  - gated: /v1/chat/completions , /v1/actions/authorize , /v1/models  (Authorization: Bearer aqta_...)
  - 401 shapes: Missing authorization / Invalid or expired API key / That does not look like an Aqta API key
  - Ed25519 attestation key aqta-att-01269bb4b6a7d950; spec github.com/Aqta-ai/attestation-spec
- App routes: public /api/status /api/verify /api/waitlist ; gated /api/keys /api/policies /api/receipts /api/stats
- Auth flow endpoints: POST /api/auth/send-otp {email}; POST /api/auth/verify-otp {email,code,inviteCode};
  POST /api/access-code/validate {code} -> {valid}; GET /api/auth/sso-check?domain=
- Error codes: work_email_required, invite_required, invite_invalid, invite_used, 429 + Retry-After
- Auth0: device flow off, password/client_credentials grant -> access_denied; /dbconnections/signup reachable
