# Permission review

- `network:provider`: requested for a future Runtime-owned provider route;
  this candidate does not make network requests.
- `secret_store:read`: requested so a reviewed Runtime route can resolve a
  credential reference without placing the secret in the extension payload.
- Human trust decision: **pending**.
- Activation remains disabled until the provider route, dependency/license
  review, and redaction smoke are approved.
