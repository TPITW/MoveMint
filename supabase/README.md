# MoveMint — Supabase backend setup

This folder turns the MoveMint portal ([`../movemint-portal.html`](../movemint-portal.html))
from a localStorage demo into a real multi-user app with authentication,
per-customer data scoping (Row Level Security) and document file storage.

- **`schema.sql`** — the one file you run. Creates the 10 tables, a profile row
  auto-created on signup, helper functions, RLS policies, and a private
  `documents` Storage bucket. It is idempotent (safe to re-run).

The column names in `schema.sql` match exactly what the portal reads and writes
(`shipToRow` / `persist*` / `rowTo*`), so **no portal code changes are needed** —
you only paste your project URL + anon key.

---

## 1. Run the schema

1. Open your MoveMint Supabase project → **SQL Editor** → **New query**.
2. Paste the entire contents of [`schema.sql`](schema.sql) and click **Run**.
3. You should see "Success. No rows returned."

> Re-running is safe. If you previously created partial tables, the
> `add column if not exists` / `drop policy if exists` guards reconcile them.

## 2. Point the portal at your project

In [`../movemint-portal.html`](../movemint-portal.html) (around line 5756), set:

```js
const SB_URL = 'https://YOUR-PROJECT-REF.supabase.co';
const SB_KEY = 'YOUR-ANON-PUBLIC-KEY';   // anon/public key ONLY — never the service_role key
```

Find both under **Project Settings → API**. The anon key is meant to be public;
security is enforced by the RLS policies, not by hiding the key.

> **Tip:** open the portal with `?demo` in the URL (e.g.
> `movemint-portal.html?demo`) to force the offline localStorage demo with no
> backend — useful for showcasing. Demo sign-in: any seeded user email (e.g.
> `admin@movemint.app`, `hassan@movemint.app`, `client@cedarmart.lb`) with
> password `movemint`. If a configured backend is unreachable, the portal also
> falls back to this demo automatically instead of hanging on the login screen.

## 3. Create users and assign roles

Auth users are created in Supabase (not in the app). A `client` profile row is
created automatically for each new user by the `on_auth_user_created` trigger.

1. **Authentication → Users → Add user** (set a password; or send an invite).
2. Promote your admin and link client logins to a customer, in the SQL Editor:

```sql
-- Make yourself an admin
update public.profiles set role = 'admin'
where email = 'admin@movemint.app';

-- An internal staff member (sees operations, not Financial/Reports/Users)
update public.profiles set role = 'staff'
where email = 'hassan@movemint.app';

-- A client login, scoped to one customer (customer_id matches customers.id, e.g. 'c1')
update public.profiles set role = 'client', customer_id = 'c1'
where email = 'client@cedarmart.lb';
```

> You can also set role/name/customer_id at signup via user metadata keys
> `role`, `name`, `customer_id` — the trigger reads them.

## 4. Load the sample data (optional)

Sign in as an **admin**, go to **Settings → "Seed sample data to Supabase"**.
This pushes the built-in demo customers, suppliers, couriers, shipments,
quotations, invoices, documents, exceptions and notifications through the app's
own writers, so every row matches the schema. (Profiles/users are **not** seeded —
they come from Supabase Auth in step 3.)

---

## Roles & access model

| Role   | Sees                                                                 | Writes |
|--------|----------------------------------------------------------------------|--------|
| admin  | Everything, incl. **Users & Access, Financial, Reports**             | All tables; manages users |
| staff  | Operations + **Directory** (Clients/Suppliers/Couriers), not financials/users/status management | Quotes, invoices, docs, directory |
| client | Only **their own** customer's shipments/invoices/quotes/notifications, and documents flagged *Customer Visible* | Request & accept their own quotes; mark their notifications read |

- **RLS** (in `schema.sql`) is the real, server-side enforcement: a client's
  anon-key session can only ever read/write rows scoped to their `customer_id`.
- The portal's role-based UI hiding (`applyRoleVisibility`, `canAccess`) is a
  convenience layer on top — it is *not* the security boundary.
- Staff-vs-admin feature gating (hiding Financial/Reports/Users from staff) is a
  **UI policy choice**, not RLS — staff can read the underlying shipments, so
  financial *figures* are derivable. Move those pages to `data-role="admin"` in
  the sidebar if you want staff to see them.
- **Deactivation is enforced at the database layer.** Setting
  `profiles.active = false` (or unchecking a user in Users & Access) cuts off all
  PostgREST/Storage access immediately — the `is_staff()`/`is_admin()`/
  `app_customer_id()` helpers all gate on `active`, so it's not just a UI flag.
- **Client writes are column-guarded by triggers**, not just row-scoped. A client
  can only *request* a quote (status `Requested`, zero pricing) and *accept/reject*
  their own — the `quotations_guard` trigger freezes pricing and other fields. A
  client can only flip the `read` flag on their own notifications
  (`notifications_guard`). Staff/admin pass through unchanged.
- ⚠️ Do **not** run `alter table public.profiles force row level security` — the
  RLS helpers rely on owner-bypass to avoid recursive profile reads.

## Document storage

- Files go to the private **`documents`** bucket under the path
  `"<tracking>/<docId>-<filename>"`. The first path segment is the shipment,
  which lets the client-read Storage policy scope downloads to a customer's own
  shipments.
- Downloads use short-lived signed URLs (120 s). Clients only see files whose
  `documents.visible = true` **and** that belong to their shipments.

## What is NOT covered yet

- **Public (unauthenticated) tracking**: `anon` has no table grants, so the
  public tracking page currently needs a login. To support anonymous tracking,
  add a narrow `anon` SELECT policy exposing only safe shipment fields.
- **Invoices** are still modeled as read-only references synced from Zoho Books;
  this schema stores them but doesn't integrate the Zoho API.
