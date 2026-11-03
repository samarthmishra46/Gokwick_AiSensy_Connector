# GoKwik → AiSensy abandoned-cart connector

When a shopper on **www.themisstt.com** enters their phone number and address in the
GoKwik checkout but doesn't pay, GoKwik sends the cart to this small web service. The
service then sends that shopper your approved WhatsApp template through an **AiSensy API
Campaign**, with their first name and a link back to their cart.

Before sending, it checks that the shopper hasn't already placed an order (via Shopify's
order webhook), that this cart hasn't been messaged before, and it keeps failed sends for a
later retry.

It runs on Vercel and has these web addresses (endpoints):

| Address                                   | What it's for                                                      |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `POST /api/gokwik/abandoned-cart?token=…` | GoKwik sends abandoned carts here.                                 |
| `POST /api/shopify/order-created`         | Shopify tells us about new orders (so buyers aren't messaged).     |
| `GET /api/cron/retry-failed`              | Resends carts whose AiSensy call failed temporarily (Vercel Cron). |
| `POST /api/test-send?token=…`             | Sends one test WhatsApp to your own number.                        |
| `GET /api/health`                         | Shows whether the service is up and which safety modes are on.     |

> **Why the old setup stopped working after moving to GoKwik checkout:** Shopify no longer
> lets GoKwik create Shopify "abandoned checkouts". Anything that relied on them (Shopify's
> abandoned-checkout webhook, Shopify abandoned-checkout emails, or AiSensy's Shopify
> abandoned-cart automation) gets nothing for GoKwik carts. This connector takes GoKwik's own
> abandoned-cart webhook instead.

It starts in two **safety modes**, and both are on by default:

- **`DISCOVERY_MODE=true`**: sends nothing. It writes the _layout_ of each GoKwik message
  to the log (field names and types only, never names or numbers) so the field mapping can be checked.
- **`DRY_RUN=true`**: never calls AiSensy. It logs the message it _would_ send.

You switch these off one at a time, in the steps below.

---

## 0. What you need

- A [Vercel](https://vercel.com) account. **Vercel's free Hobby plan is for non-commercial use
  only.** A connector for a live store counts as commercial, so plan on the **Pro** plan.
- Your AiSensy account (with an approved abandoned-cart template).
- Access to the GoKwik merchant dashboard (merchant ID `19fb3xsddvju`).
- On your computer: [Node.js 22](https://nodejs.org) and the Vercel command-line tool:
  ```bash
  npm install -g vercel
  ```
- Two long random passwords ("tokens"). Create each one with either command and save them somewhere safe:
  ```bash
  openssl rand -hex 32
  # or
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
  One is your **GoKwik webhook token** and the other is your **admin token**. Tokens may only
  contain letters, digits and `. _ ~ -` because they go inside a web address.

> **Windows:** run the `curl` commands below in **Git Bash**, or type `curl.exe` instead of
> `curl` in PowerShell.

---

## 1. Deploy to Vercel

In this folder:

```bash
npm install
vercel            # log in, then answer the questions: "Link to existing project?" No,
                  # give it a name (e.g. misstt-abandoned-cart). Accept the defaults.
```

Then open **Vercel → your project → Settings → Environment Variables** and add the variables
listed below for the **Production** environment. `.env.example` explains each one.

| Variable                   | What to put                                                             |
| -------------------------- | ----------------------------------------------------------------------- |
| `GOKWIK_WEBHOOK_TOKEN`     | Your GoKwik webhook token (**required**)                                |
| `AISENSY_API_KEY`          | AiSensy → Manage → API Key (**required** before going live)             |
| `AISENSY_CAMPAIGN_NAME`    | Exact name of your Live API campaign (**required** before going live)   |
| `ADMIN_TOKEN`              | Your admin token (for the test endpoint)                                |
| `TEST_PHONE`               | Your own WhatsApp number, e.g. `98XXXXXXXX`                             |
| `DRY_RUN`                  | `true` for now                                                          |
| `DISCOVERY_MODE`           | `true` for now                                                          |
| `UPSTASH_REDIS_REST_URL`   | Strongly recommended, see [Duplicate protection](#duplicate-protection) |
| `UPSTASH_REDIS_REST_TOKEN` | Strongly recommended                                                    |
| `SHOPIFY_WEBHOOK_SECRET`   | For the already-ordered check, see [step 4b](#4b-shopify-order-webhook) |
| `CRON_SECRET`              | For automatic retries, see [Retry queue](#retry-queue)                  |

Everything else has sensible defaults (store name THE MISSTT, store URL, country code 91, …).

Deploy to production:

```bash
vercel --prod
```

Vercel prints your address, e.g. `https://misstt-abandoned-cart.vercel.app`. Open
`https://<your-project>.vercel.app/api/health` in a browser. You should see:

```json
{
  "ok": true,
  "dryRun": true,
  "discoveryMode": true,
  "dedupe": "off",
  "orderCheck": "off",
  "retryQueue": "off"
}
```

`dedupe`/`retryQueue` turn `"redis"` once Redis is set; `orderCheck` turns `"on"` once Redis
and `SHOPIFY_WEBHOOK_SECRET` are set.

> **Important:** Vercel only picks up changed environment variables on a **new deployment**.
> After you change any variable, run `vercel --prod` again (or use **Redeploy** in the Vercel dashboard).

---

## 2. Set up AiSensy

1. **Template.** In AiSensy, create (or reuse) an abandoned-cart template and get it approved
   by WhatsApp. By default the service fills in:
   - `{{1}}` = customer's first name (or "there" if unknown)
   - `{{2}}` = the link back to their cart

   Example body: _"Hi {{1}}, you left something lovely in your cart at THE MISSTT 💕 Complete
   your order here: {{2}}"_

   You can use other values, in any order, by setting `AISENSY_TEMPLATE_PARAMS`, e.g.
   `first_name,items_summary,cart_total,recovery_url`. Available values: `first_name`,
   `recovery_url`, `cart_total`, `items_summary` (e.g. "Floral Dress and 2 more"), `store_name`.
   **The number and order must exactly match the template's `{{n}}` variables**, or AiSensy rejects the message.

   Use a template **without an image/video header**. This connector doesn't send media.

2. **API Campaign.** Go to **Campaigns → API Campaign → Launch**, choose the template, and
   finish the setup. Make sure the campaign is **Live**.
3. Copy the **campaign name** exactly as shown into `AISENSY_CAMPAIGN_NAME`, and your
   **API key** (Manage → API Key) into `AISENSY_API_KEY`. Redeploy (`vercel --prod`).

### Link in the message body vs. in a button

By default the cart link goes into the message **body** (`{{2}}`). That always works.

WhatsApp **URL buttons** only allow a _fixed_ start of the address with a variable ending,
like `https://www.themisstt.com/{{1}}`. GoKwik's recovery link may sit on a GoKwik domain
rather than themisstt.com, and then a button with your domain would point to the wrong place.
So only use a button if discovery (step 5) shows the recovery link is on a domain you can fix
in the template. In that case:

- create the template with a URL button whose fixed part is everything up to the path, e.g.
  `https://<that-domain>/{{1}}`
- set `AISENSY_BUTTON_URL_SUFFIX_FROM=recovery_url_path`. The service then sends the part
  after the domain (path and `?query`) as the button's variable.
- the service always sends the variable for the **first** button (index 0).

Carts without a usable link are skipped while button mode is on (logged as `cannot_build_message`).

---

## 3. Test AiSensy on its own

This step doesn't involve GoKwik. Set `DRY_RUN=false` in Vercel (keep `DISCOVERY_MODE=true`),
run `vercel --prod`, then:

```bash
curl -X POST "https://<your-project>.vercel.app/api/test-send?token=<ADMIN_TOKEN>"
```

You should get `{"ok":true,"dryRun":false,"aisensyStatus":200,...}` and, within a minute, a
WhatsApp message on `TEST_PHONE` with the name "Test" and a link to www.themisstt.com.

If you get `"ok":false`, the `error` field contains AiSensy's reason. See
[Troubleshooting](#6-troubleshooting).

> With `DRY_RUN=true`, this command sends nothing and shows you the message it would send (`wouldSend`).

---

## 4. Set up GoKwik

> ⚠️ **Read first.** GoKwik says this webhook **cannot be used together with "Send
> Abandoned Checkouts to Shopify"**. Turning the webhook on may switch that setting off. That
> stops abandoned checkouts appearing in Shopify, and with it any Shopify-based or
> AiSensy-Shopify abandoned-checkout flow you already run. This connector becomes your
> abandoned-cart flow. Make sure you're happy with that, and turn off any other
> abandoned-cart WhatsApp automation so customers don't get two messages.

1. GoKwik dashboard → **Kwik Checkout → Settings → Integrations → Re-Marketing Tools →
   Abandoned Cart → Configure Webhooks**.
2. **Webhook URL:**
   ```
   https://<your-project>.vercel.app/api/gokwik/abandoned-cart?token=<GOKWIK_WEBHOOK_TOKEN>
   ```
   (You can open this address in a browser to check it. It shows `{"ok":true,...}` when the token is correct.)
3. **Cart State:** `Address Added`.
4. **Save.** GoKwik says the setup can take **24–48 hours** to start sending, and it sends a
   cart only once it counts as abandoned. A message won't go out the moment someone closes the checkout.

Treat this URL like a password: anyone who has it can send fake carts to the service. If it
leaks, change `GOKWIK_WEBHOOK_TOKEN` in Vercel, redeploy, and update the URL in GoKwik.
(GoKwik doesn't document a signature for this webhook, so the secret token in the URL is the
authentication.)

## 4b. Shopify order webhook

GoKwik orders still arrive in Shopify as normal orders (prepaid and COD). This webhook
tells the connector who has ordered, so a shopper who abandoned and then bought isn't asked
to "complete your order". It needs Redis (see [Duplicate protection](#duplicate-protection)).

1. Shopify admin → **Settings → Notifications → Webhooks** → **Create webhook**.
2. Event **Order creation**, format **JSON**, URL
   `https://<your-project>.vercel.app/api/shopify/order-created`, latest API version. Save.
3. Under the webhook list Shopify shows _"Your webhooks will be signed with …"_. Copy that
   key into `SHOPIFY_WEBHOOK_SECRET` in Vercel and redeploy.
4. Use **Send test** in Shopify: the Vercel log shows `order_recorded` (or
   `order_without_phone` for Shopify's sample order). `/api/health` shows `"orderCheck": "on"`.

Each phone on the order (order, customer, billing and shipping phone) is remembered as a
one-way hash for `ORDER_SUPPRESS_SECONDS` (default 24 h). Abandoned carts from that phone are
skipped with `reason: order_completed`, including carts waiting in the retry queue.

Limit: the check only knows about orders placed **before** GoKwik sends the abandoned cart.

---

## 5. Discovery: check the field mapping, then go live

GoKwik doesn't publish the exact format of its webhook, so check it once with a real cart.

1. Keep `DISCOVERY_MODE=true`.
2. Make a test abandoned cart: on www.themisstt.com add something to the cart, open the GoKwik
   checkout, enter **your own** phone number and OTP and an address, then close it **without paying**.
3. Wait for GoKwik to send it (see the timing note above). Then open **Vercel → your project →
   Logs** and search for `discovery_`. You'll see two kinds of lines:
   - `discovery_shape`: every field in GoKwik's message, with its type and a masked sample. Example:
     ```
     customer.phone  string  [phone: 12 digits, + prefix]
     customer.first_name  string  Pr…(5)
     abc_link  string  https://pdp.gokwik.co/…(96)
     ```
   - `discovery_extracted`: what the service picked for each field and where it found it.
     Example:
     `"phone":{"path":"customer.phone","via":"candidate","sample":"91XXXXXX1234"}`.
     `NOT FOUND` means nothing matched.
4. If a pick is wrong or `NOT FOUND`, point the service at the right field with a `MAP_*`
   variable, using the path exactly as shown in `discovery_shape`:

   | Variable      | Field                 | Example                       |
   | ------------- | --------------------- | ----------------------------- |
   | `MAP_PHONE`   | customer phone        | `customer.phone`              |
   | `MAP_NAME`    | first (or full) name  | `shipping_address.first_name` |
   | `MAP_LINK`    | link back to the cart | `abc_link`                    |
   | `MAP_CART_ID` | unique cart id        | `request_id`                  |
   | `MAP_TOTAL`   | cart total            | `total_price`                 |

   For a permanent fix, a developer can instead move the right path to the top of the lists in
   `src/extract.ts` (`FIELD_CONFIG`).

   Also note the **domain of the link** (e.g. `https://pdp.gokwik.co/…`) if you're thinking about a URL button.

5. Set `DISCOVERY_MODE=false` (keep `DRY_RUN=true`), redeploy, and make another test cart. In
   the logs, look for `dry_run_would_send`. It shows the exact message that would go to AiSensy.
6. When that looks right, set `DRY_RUN=false`, redeploy, and you're live. 🎉

---

## 6. Troubleshooting

Each cart produces one `cart_result` log line with a `status` (`sent` / `skipped` /
`rejected` / `failed`) and a `reason`. On success it also has `httpStatus` and
`aisensyResponse` (AiSensy's reply, phone digits masked). With Redis, the last result per cart is
also kept as `gk:status:<cart id>` (no personal data) for 48 h.

| What you see                                                                                          | What it means / what to do                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 unauthorized`                                                                                    | The `token=` in the URL doesn't match `GOKWIK_WEBHOOK_TOKEN` (or `ADMIN_TOKEN` for test-send). Check for typos or missing characters, and redeploy after changing a variable.                                                                                                                                                   |
| `500 "Server misconfigured"`                                                                          | A variable is missing or invalid. Search the logs for `config_invalid`. It names the variable (never its value).                                                                                                                                                                                                                |
| `reason: missing_phone`                                                                               | No phone number found in the cart. Run discovery and set `MAP_PHONE`.                                                                                                                                                                                                                                                           |
| `reason: invalid_phone`                                                                               | The number isn't 10 digits, or 91 + 10 digits, after cleaning (the log shows only the last 4 digits). Usually a typo by the shopper, so nothing to do. If many numbers fail, `MAP_PHONE` may point to the wrong field.                                                                                                          |
| `no_recovery_link` warning                                                                            | No cart link found, so `STORE_URL` was sent instead. Run discovery and set `MAP_LINK`.                                                                                                                                                                                                                                          |
| `status: rejected`, `reason: aisensy_rejected` (400/404, or a 2xx whose body says `"success": false`) | AiSensy refused the message; `detail` has their reason. Common causes: campaign not **Live**, wrong `AISENSY_CAMPAIGN_NAME` (must match exactly), number of template params doesn't match `AISENSY_TEMPLATE_PARAMS`, or the number isn't on WhatsApp. These are **not retried** and are counted as `rejected`, never as `sent`. |
| `reason: aisensy_auth_error` (status 401/403)                                                         | Wrong or revoked `AISENSY_API_KEY`. The cart is kept in the retry queue: fix the key, redeploy, and the next retry run sends it.                                                                                                                                                                                                |
| `reason: aisensy_transient_error` (status 429/5xx, timeout)                                           | AiSensy was busy or down. The cart goes into the retry queue, and the service answers GoKwik with 500 in case GoKwik retries too. With Redis on, retries never double-send.                                                                                                                                                     |
| `reason: order_completed`                                                                             | The shopper already placed a Shopify order. Working as intended.                                                                                                                                                                                                                                                                |
| `reason: missing_recovery_link`                                                                       | `REQUIRE_RECOVERY_LINK=true` and the cart had no link. Run discovery and set `MAP_LINK`.                                                                                                                                                                                                                                        |
| `reason: not_abandoned_event`                                                                         | `ALLOWED_EVENT_TYPES` is set and the cart's `MAP_EVENT_TYPE` value isn't in it.                                                                                                                                                                                                                                                 |
| `reason: store_error` / `dedupe_error`                                                                | Redis was unreachable. Nothing was sent; the service answered 500 so GoKwik can retry.                                                                                                                                                                                                                                          |
| `retry_gave_up`                                                                                       | A cart failed `RETRY_MAX_ATTEMPTS` times or is older than 24 h. Check the earlier `cart_result` / `retry_result` lines for the reason.                                                                                                                                                                                          |
| `reason: duplicate`                                                                                   | The cart was already messaged in the last 48 h (`DEDUPE_TTL_SECONDS`). This is normal when GoKwik retries.                                                                                                                                                                                                                      |
| Customers get two messages                                                                            | Turn on duplicate protection (Redis, below), and make sure no other abandoned-cart automation (Shopify / AiSensy-Shopify) is also running.                                                                                                                                                                                      |
| `reason: deferred_time_budget`                                                                        | GoKwik sent so many carts at once that they didn't fit in one 10 s request. The rest go into the retry queue.                                                                                                                                                                                                                   |
| `/api/health` shows `"ok": false`                                                                     | Same as "Server misconfigured" above.                                                                                                                                                                                                                                                                                           |
| Nothing arrives from GoKwik at all                                                                    | GoKwik can take 24–48 h after saving the webhook, and only sends carts once they're abandoned (Address Added state). Check the URL in GoKwik matches exactly, including `?token=`.                                                                                                                                              |

---

## 7. Privacy

- Only shoppers who typed their own number into checkout (and verified it with an OTP) are
  messaged. Use a template that WhatsApp approved for this purpose.
- AiSensy handles opt-outs: check its opt-out keyword settings so shoppers who reply STOP aren't
  messaged again, and respect any opt-out requests you receive directly.
- The service **never logs raw GoKwik payloads** (they contain names, phones and addresses). Phone
  numbers in logs show the last 4 digits only (`91XXXXXX1234`), and the AiSensy API key is never logged.
- **Dry-run logs** (`dry_run_would_send`) do include the shopper's first name and cart link, so
  you can check the message. Don't leave `DRY_RUN=true` running on real traffic longer than you need.
- With Redis on, the service stores: a short-lived "already sent" marker and a status record per
  cart (the cart id, or a one-way hash of phone + link; 48 h), a one-way hash of each phone
  that placed a Shopify order (`ORDER_SUPPRESS_SECONDS`), and **only for carts whose send
  failed**, the phone, first name, cart link and cart summary needed to retry (deleted when
  sent, or after 24 h at most).

---

## Reference

### Duplicate protection

GoKwik retries when the service answers with an error. Without memory, a retry could message
the same shopper twice. To prevent this, create a free **Upstash Redis** database (from your Vercel
project's **Storage** tab, or at [upstash.com](https://upstash.com)) and set
`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. The `KV_REST_API_URL` /
`KV_REST_API_TOKEN` names that Vercel's integration creates also work. `/api/health` then
shows `"dedupe": "redis"`.

How it works:

- Before sending, the service stores `gk:ac:<cart id>` for 48 h. If the key already exists, the cart is skipped as a duplicate.
- If AiSensy fails temporarily, the key is removed so a retry (ours or GoKwik's) can send.
- Dry-run and discovery modes never write keys, so testing doesn't block real messages later.
- Rare edge case: if the function is cut off mid-send (10 s limit), the cart is treated as sent
  and not retried. That trades one possibly missed message for never double-sending.

### What gets sent to AiSensy

```json
{
  "apiKey": "<AISENSY_API_KEY>",
  "campaignName": "<AISENSY_CAMPAIGN_NAME>",
  "destination": "+919876543210",
  "userName": "Priya",
  "templateParams": ["Priya", "https://…recovery-link…"],
  "source": "gokwik-abandoned-cart",
  "paramsFallbackValue": { "FirstName": "there" }
}
```

How this compares with AiSensy's public API reference
([aisensy.com/tutorials/api-reference-docs](https://aisensy.com/tutorials/api-reference-docs)),
checked October 2026:

- **Endpoint** `POST https://backend.aisensy.com/campaign/t1/api/v2`: matches.
- **`destination`**: the docs say "mobile number with country dial code". Their example is
  `+917428526285`, and the `+` is optional for Indian numbers but required for other countries.
  The service always sends `+<country code><number>` (change `toAiSensyDestination` in
  `src/phone.ts` if needed).
- **`userName`** is listed as required. The service always sends one (the first name, or `FALLBACK_NAME`).
- **`templateParams`** must have exactly as many values as the campaign's template variables.
- **`buttons`** and **`paramsFallbackValue`** are **not in the public reference**. The
  service uses the shapes commonly shown in AiSensy's in-dashboard API-campaign sample and the
  WhatsApp Cloud API button format (`{type:"button", sub_type:"url", index:0, parameters:[{type:"text", text}]}`).
  Before relying on a URL button, compare this with the sample payload AiSensy shows on your
  campaign page. `paramsFallbackValue` is harmless if ignored, because every param is always filled.
- **`media`, `tags`, `attributes`** are optional in the docs and not sent.
- The docs promise a 200 on success and don't document error formats. The service treats 429
  and 5xx (and timeouts/network errors) as temporary, and any other 4xx as permanent.

### Retry queue

GoKwik doesn't document whether it retries failed webhooks, so the service doesn't rely on
it. When an AiSensy call fails temporarily (network, timeout, 429, 5xx), with an auth error
(401/403), or doesn't fit in the request's time budget, the cart is saved in Redis and
`/api/cron/retry-failed` resends it with backoff (5 min, 10 min, 20 min … up to 2 h between tries),
for up to `RETRY_MAX_ATTEMPTS` (default 6) attempts and at most 24 h. Each retry re-checks
duplicate protection and the already-ordered marker, and uses the **current** API key and
campaign settings.

To run it automatically, set `CRON_SECRET` (16+ random characters) and add a cron to
`vercel.json`:

```json
"crons": [{ "path": "/api/cron/retry-failed", "schedule": "*/10 * * * *" }]
```

> Vercel's Hobby plan only allows **daily** crons, and deploying a more frequent schedule
> fails. On Hobby use `"0 3 * * *"` or call the endpoint from an external scheduler.

You can also run it by hand:
`curl "https://<your-project>.vercel.app/api/cron/retry-failed?token=<ADMIN_TOKEN>"`. It does
nothing while `DRY_RUN` or `DISCOVERY_MODE` is on.

### All settings

See [`.env.example`](.env.example). Empty values count as "not set". Boolean settings accept
`true`/`false` (also `1`/`0`, `yes`/`no`). `DRY_RUN` and `DISCOVERY_MODE` default to **true**
when missing, so the service fails safe.

### Webhook responses (what GoKwik receives)

- `200 {"received":N,"sent":N,"skipped":N,"rejected":N,"failed":0,"mode":"live"}`: done;
  nothing for GoKwik to retry. `rejected` carts were refused by AiSensy (see the logs).
- `500 {…,"failed":N}`: at least one cart hit a temporary AiSensy or Redis problem. GoKwik
  may retry. The cart is also in the retry queue when Redis is on.
- `400`: the body wasn't JSON or form data.
- `401`: wrong or missing token.

The body can be one cart, an array of carts, or a wrapper such as `{ "data": [...] }` or
`{ "carts": [...] }`. JSON and form-encoded bodies are both accepted.

---

## For developers

```bash
npm install
npm test            # vitest, with fetch and Redis mocked; no network calls
npm run typecheck   # tsc --noEmit
npm run format      # prettier
```

Layout: `api/` holds the Vercel Functions (web-standard `Request → Response` handlers,
Node 22 runtime, `maxDuration` 10 s, region `bom1` Mumbai). `src/` holds the logic:
`config` (zod env validation), `extract` (field resolver + `FIELD_CONFIG`), `phone`,
`aisensy`, `deliver` (per-cart send pipeline shared by the webhook and the retry cron),
`store` (Redis: dedupe, orders, retry queue, status), `discovery`, `log`, `http`.

### Running locally with `vercel dev`

`vercel dev` needs the folder linked to a Vercel project first (step 1 does that). The
`dev` script is `vc dev` (the Vercel CLI's short name) because the CLI refuses to start
when the `dev` script literally reads `vercel dev`.

```bash
cp .env.example .env    # then set GOKWIK_WEBHOOK_TOKEN=localtest0123456789abcdef
npm run dev             # http://localhost:3000
```

Health:

```bash
curl http://localhost:3000/api/health
```

Fake cart in **discovery** mode (`DISCOVERY_MODE=true`). Returns `"mode":"discovery"`, and the
terminal shows `discovery_shape` / `discovery_extracted`:

```bash
curl -X POST "http://localhost:3000/api/gokwik/abandoned-cart?token=localtest0123456789abcdef" \
  -H "content-type: application/json" \
  -d '{"data":[{"request_id":"fake-1","customer":{"first_name":"Testy","phone":"+919000000001"},"abc_link":"https://checkout.example.test/r/fake-1","total_price":1299,"line_items":[{"title":"Fake Dress"},{"title":"Fake Top"}]}]}'
```

Same cart in **dry-run** mode (`DISCOVERY_MODE=false`, `DRY_RUN=true`). Returns
`"sent":1,"mode":"dry_run"`, and the terminal shows `dry_run_would_send` with the AiSensy body:

```bash
curl -X POST "http://localhost:3000/api/gokwik/abandoned-cart?token=localtest0123456789abcdef" \
  -H "content-type: application/json" \
  -d '{"cart_id":"fake-2","phone":"9000000002","first_name":"Testy","kwik_link":"https://checkout.example.test/r/fake-2"}'
```

Form-encoded:

```bash
curl -X POST "http://localhost:3000/api/gokwik/abandoned-cart?token=localtest0123456789abcdef" \
  --data-urlencode "phone=9000000003" --data-urlencode "name=Testy Fake"
```

Wrong token (expect `401`):

```bash
curl -i -X POST "http://localhost:3000/api/gokwik/abandoned-cart?token=wrong" -d '{}'
```

# Gokwick_AiSensy_Connector
