# Braam Street Barbers booking

Node.js website for 30-minute barber appointments. Customers pick a service and free slot, create an account with their mobile number and password, and can return to view or cancel bookings. A database unique key prevents two confirmed bookings in the same slot.

This version uses **no paid messaging service**. The optional WhatsApp button opens a normal chat with a prefilled message; a person at the shop handles that conversation. There is no automated WhatsApp bot or phone OTP in this version. Phone numbers are contact details and are not verified. No payment or automatic fee collection is included.

## Run locally

Requires Node.js 22 or later.

```bash
npm install
npm start
```

Open `http://localhost:3000`. Local development uses `data/bookings.sqlite`; the file is ignored by Git. Run `npm test` for account and booking checks.

## Hostinger Web App setup

1. Deploy this GitHub repository as a Node.js Web App. Use Node.js 22 or 24, npm, `npm start`, and entry file `app.js`. There is no build step.
2. Create a MySQL database in Hostinger under **Websites → Dashboard → Databases → Management**. Hostinger's managed database is MySQL compatible. Enter its credentials as environment variables for this web app. Choose either:
   - `DATABASE_URL=mysql://user:password@localhost:3306/database_name`, **or**
   - `DB_HOST`, `DB_PORT` (normally `3306`), `DB_USER`, `DB_PASSWORD`, and `DB_NAME`.
3. Set `NODE_ENV=production` and `PUBLIC_BASE_URL=https://your-real-domain` in the web app environment. Set `BUSINESS_WHATSAPP_NUMBER=+27...` if you want the manual WhatsApp chat button to appear. `BUSINESS_ADDRESS` is optional; the screenshot address is already the default. `DB_SSL=false` is the default for Hostinger's local database connection; set it to `true` only if your MySQL connection requires TLS.
4. Restart or redeploy after adding environment variables. Test a booking on the live site and verify the record in Hostinger's database dashboard before sharing the site.

The app creates its tables on startup. Keep database credentials in Hostinger environment variables, never in Git. See [Hostinger's MySQL connection guide](https://www.hostinger.com/support/connecting-a-hostinger-mysql-database-to-a-node-js-application/) for finding the database name, username, password, and host.

## Hours, services, and policies

The opening hours from the supplied screenshot are in `src/config.js` as `SCHEDULE`:

| Day | Hours |
| --- | --- |
| Monday–Thursday | 08:00–20:00 |
| Friday | 08:00–17:30 |
| Saturday | 08:00–14:30 |
| Sunday | Closed |

There is **no `SCHEDULE_JSON` setting**. To change hours, edit `SCHEDULE` in `src/config.js`, commit, and push. Times use `Africa/Johannesburg`. Slots start every 30 minutes, end before closing, and can be booked 30 days ahead with at least one hour's notice.

Service prices are full cut R150, only fade R130, mullet taper R100, full beard work R20, and line ups R10. Each online booking reserves one 30-minute slot. Starts from 18:00 to 18:59 add R10; 19:00 to 19:59 add R20. For 20:00 onward, customers should ask by WhatsApp as the regular online calendar closes at 20:00. The displayed policies are R30 for arrival 7+ minutes late and R80 for cancellation within 3 hours or a no-show. Late cancellation fees are recorded but not charged through the site.

The WhatsApp number was not in the screenshots, so add it through `BUSINESS_WHATSAPP_NUMBER` when ready. The logo is in `public/assets/braam-street-logo.png`.

## Account limitation

Without a messaging provider, the site cannot prove that a customer owns the number entered. Passwords are salted and hashed, but self-service password recovery is not included. A customer who forgets their password will need help from the shop. Do not collect sensitive payment details through this site or a regular WhatsApp chat.
