# Catalog, pricing and operation workflows

## Deployment

Deploy the backend source, then run the existing commands in the API application directory:

```sh
npm run build
npm run migration:run
```

Restart the cPanel Node application and deploy the matching frontend build. Schema synchronization remains disabled. No additional seeding command is needed for the new permissions. Migrations 174925–174927 add the order records, pricing and production activity fields without replacing existing item or transaction records.

Existing posted sales and purchases stay posted; they are not reconstructed as pending orders. Existing production orders already in progress can continue. Released production orders must have their materials handed over and be explicitly started before completion.

## Items and variants

Open **Item catalog** (`/items`) to find every SKU, including archived items and items without stock rows. Open an item to view it, then choose **Edit item**. Editing its name, SKU, barcode, image or active status does not create stock or rewrite historical quantities. Use stock adjustments, receipts or production for quantity changes.

An item with transactions, documents, conversions or family membership keeps its historical base stock unit. For example, CC-CRM-001 remains in cm after its DAMAGE adjustment. Use a same-category metre conversion (1 m = 100 cm), rather than redefining its history.

Product families configure attributes and values once. Generate selected combinations as separate variants, each with a unique SKU, stock, image and BOM. The stock location is optional when generating variants: catalog-only variants become available for editing and quoting before any receipt. Variant type and unit configuration are inherited from their family; existing family stock definitions cannot be rewritten after variants exist.

Unit categories contain compatible physical measurements. Packaging profiles express reusable pack/roll sizes; they do not permit arbitrary mass-to-length conversions. Width × length entry requires an area unit. Standard physical ratios stay fixed.

## Sales prices

Only users with **pricing.write** can configure prices. A single item's standard price is per base stock unit. Prices support up to ten decimal places for small units. For example, Br100/m is Br1/cm, and Br15/m² is Br0.0015/cm².

For families, configure **Sales price & variant surcharges**: family base price plus the extra price for every selected attribute value. This is calculated at quotation validation; changing family pricing updates the current standard without rewriting existing orders. A separately configured variant price overrides the family calculation. Clear the variant override to inherit again. If neither a variant nor its family has a price, the quotation requires approval.

Different prices or a commission rate/basis different from the standard (10% of profit) require **sales.approve** and an approval reason. The author, reviser or submitting user cannot approve their own price exception. Assign this permission to a separate authorized manager in Roles. Revisions reset previous approvals. Standard prices are rechecked at confirmation; approved exception prices and conversion snapshots are preserved. Editing posted sale lines cannot bypass these checks.

## Sales

1. **Quotation (DRAFT):** prepare customer, quantities, units, prices and payment terms. No stock or financial postings.
2. **Submit:** standard prices validate automatically; exceptions enter **PENDING_APPROVAL**.
3. **APPROVED:** a separate approver accepts an exception, or all prices match configuration. Rejection returns the quotation for revision.
4. **CONFIRMED:** sales confirms the order and stock is reserved. Quantities on hand and bank/credit balances remain unchanged.
5. **DELIVERED:** a user with **sales.deliver** validates delivery. The reservation is consumed, stock is issued and the sale/bank or credit posting is created atomically. Repeating delivery cannot post a second sale.
6. **CANCELLED:** cancellation before delivery releases any reservation. Delivered orders require the existing return process. Commercial lines from delivered orders are locked; notes remain editable where supported.

The sidebar opens sales orders. **Posted sales & invoices** opens historical and delivered transactions. The legacy direct sale endpoint is an immediate delivery/posting operation and requires both sales.write and sales.deliver; it still enforces configured prices.

## Purchasing

1. **DRAFT:** purchasing prepares a purchase request/order. No stock or financial postings.
2. **CONFIRMED:** the supplier order is confirmed and awaits physical receipt.
3. **RECEIVED:** a stock keeper with **purchase.receive** validates receipt; stock, cost and the bank/supplier-credit posting are created in one transaction. Repeated receipt is safe.
4. **CANCELLED:** an unreceived order can be cancelled. A received order cannot be cancelled or have its commercial lines silently rewritten.

The legacy direct purchase endpoint posts an immediate receipt and requires purchase.write plus purchase.receive. Existing purchases remain available under **Posted receipts & purchases**.

## Production

1. **DRAFT:** production manager prepares the work order and BOM requirements.
2. **Request materials (RELEASED):** production manager requests and reserves available components. Shortages prevent reservation and notify purchasing.
3. **Warehouse handover:** only production.issue can hand over materials. Every issue records its actor and movement. A partial handover remains pending; it does not start production.
4. **Start (IN_PROGRESS):** production manager accepts the handover and starts after all requested components have been issued.
5. **Completion:** record partial or full finished output. Completion cannot auto-issue materials. Full completion becomes **COMPLETED**, with finished goods available in the receipt location for sales/delivery.

Actual issued material value contributes to finished-goods stock cost. Labor/overhead absorption, shop-floor work centers and separate quality-control acceptance are not implemented.

Default Production Manager loses production.issue; Stock Keeper loses production.write. Warehouse Operator and Stock Keeper receive sales.deliver, purchase.receive and the read permissions needed to review those orders. Admin retains all permissions. Existing custom roles need an explicit review of these new capabilities.

## Scope and limitations

Order actions and production steps record who performed them and when. Item images are served through the frontend's fixed backend image route, using API_URL rather than a browser-local fallback. The route allows only item raster image filenames.

The current sales and purchase order flows validate full deliveries/receipts. Split shipments, partial purchase receipts/backorders, separate invoice/payment authorization, customer-specific pricelist tiers and supplier returns are further extensions. Transfers and stocktakes retain their existing guarded operation states; financial documents use posted/voided states separately from payment settlement.

References: [Odoo sales flow](https://www.odoo.com/documentation/19.0/applications/sales/sales.html), [variant price extras](https://www.odoo.com/documentation/19.0/applications/sales/sales/products_prices/products/variants.html), [unit categories](https://www.odoo.com/documentation/17.0/applications/inventory_and_mrp/inventory/product_management/configure/uom.html), [separate material picking and manufacturing](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/manufacturing/basic_setup/three_step_manufacturing.html).
