# Customer directory

The inquiry customer picker loads every page through the shared customer-directory fetcher. It retains a newly created customer after refreshing the options. Labels include available phone/email details to distinguish customers with the same name.

The customer list remains paginated, with newest records first. Creating a customer from the list clears its search and returns to page one so the new record is visible.

## Phone policy

Phone numbers are optional free-text contact details. They are not normalized or required to be unique. The temporary phone format, required-field and uniqueness feature has been reverted. Existing stored customer details and history are preserved.

Migration `1749240000000-RemoveCustomerPhoneValidation` removes the database phone trigger, normalized-key indexes, helper column and functions for servers where `1749230000000-CustomerPhoneIdentity` was already applied. The earlier migration stays in history; do not remove migration records or run a database reset.

After deploying the updated backend source, use the usual commands:

```sh
npm run build
npm run migration:run
```

Restart the backend through cPanel before deploying the frontend. No seed command is required.
