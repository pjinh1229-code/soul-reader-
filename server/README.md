# Billing backend preparation

This directory currently contains the provider-independent Google Play purchase
response validator. **It is not a deployed billing server and does not enable
live purchases.** Authentication, a durable transaction store, HTTP routes,
Google API credentials, acknowledgement retries, refund reconciliation and
hosting still need to be implemented and connected.

Run the existing tests with Node22 or newer; no package installation is needed:

```sh
cd server
npm test
```

`normalizePlayPurchaseV2` accepts a response fetched by the backend from the
official `purchases.productsv2.get` endpoint. Its expected context must come
from server configuration, the authenticated user's prepared purchase intent
and the durable ledger. Never build that context from unverified client fields.
The configured package is bound by the trusted API request URL; the v2 response
itself does not carry a package name.

The validator requires a completed purchase, the exact single product/purchase
option, quantity1/refundableQuantity1 and the prepared obfuscated account/profile
identifiers. It permits pending acknowledgement before consumption. Already
consumed purchases are accepted only when the backend has a matching durable
transaction. An optional Google order ID is not treated as payment proof. The
result contains no purchase token, personal identity or entitlement grant.

Persist an idempotent entitlement and finalization job atomically before any
acknowledgement or consumption. A later replay must never reactivate a refunded
or revoked ledger entry. The current Android client consumes after verification;
do not add server-side consumption without coordinating that protocol. A server
acknowledgement retry can protect against the client disappearing after a grant.

Registered catalogue, as reported by the owner:

| Product | Purchase option | Korean price | Scope |
| --- | --- | --- | --- |
| `soul_reading_single` | `single` | KRW990 | One selected topic for one photo reading |
| `soul_reading_bundle` | `bundle` | KRW1990 | All four topics for one photo reading |

Keep one default/backward-compatible buy option per product for the currently
pinned Flutter billing plugin. It does not expose arbitrary one-time offer
tokens/purchase-option selection. The server must still validate the option ID.

The Google/Firebase project and hosting/cost preference have not yet been
provided. Do not create paid resources or label this component production-ready.
