# Product families and variants

## Operator setup

1. Open **Product attributes** in Master data. Create reusable attributes such as Finish, Material or Size, with their allowed values.
2. Open **Product families → New product family**. Enter the shared name and item type, choose the unit configuration and select the applicable attribute values.
3. On the family details page, select the values to combine and click **Preview combinations**. Review the generated SKUs, optionally supply barcodes and deselect combinations you do not offer. Previews and saves are limited to 100 combinations per batch; narrow the selected values for larger families.
4. Choose the initial stock location and create the selected variants. Each is a separate normal item with a zero stock balance. Receive purchases, complete production or post an opening adjustment to add quantities and value.
5. Use the variant's action menu to edit its inventory details and image, or create its own BOM. Purchase, inquiry, sale, BOM and production selectors use the exact item description and SKU. Manufacturing costs and sales cost snapshots therefore remain specific to each variant.

For an existing product use **Link existing item**. It needs a SKU and the same item type, stock unit and shared unit configuration as the family, with no item-specific conversions or phantom setting. Linking retains its item ID, name, SKU, barcode, quantities, costs, movements and document links. A zero balance is created in the selected location only if one does not already exist.

## Rules

- Each family attribute has exactly one selected value per variant. Combinations are unique even if attribute selections are submitted in a different order. Archived combinations cannot be recreated; activate the existing variant instead.
- All variants share the family's base stock unit and unit configuration. Item type and unit configuration are protected after the first variant exists. Shared conversion ratios remain managed in Units of measure; historical transaction snapshots retain their original factors.
- Attribute values used by families cannot be removed or renamed. New values may be added. Adding another attribute dimension to a family that already has variants requires a new family.
- New variants require unique, non-empty SKUs. Barcodes are optional and unique when supplied. Existing variants cannot have their SKU cleared.
- Variant generation and existing-item linking are atomic transactions. A conflict or invalid combination rolls back the entire batch. Family and item locks plus the database unique index protect simultaneous requests.
- Each manufactured variant uses a separate BOM. Shared BOMs with conditional components are not part of this version. Existing BOM revision/copy flows can be used to reuse a recipe.
- Family descriptions are notes, not a stock-bearing parent. Family archiving stops variant generation and leaves existing variants unchanged. Variant bulk archiving is permitted only with zero stock/reservations and no open production orders. Historical records remain available; new transaction normalization rejects archived items.
- Cost remains the existing per-item/per-location stock valuation; manufacturing still includes issued material value only. Selling prices are entered on sales; this feature does not add a persistent variant price list or labour/overhead costing.
- Configuration uses `inventory.read` / `inventory.write`. Stock locations are checked against the operator's scope. Variant stock summaries include only permitted locations. Audit events retain the users who created, linked, edited or archived records; generated inventory rows also record their creator.

## API

All routes are below `/api/v1/product-families`:

- `GET /attributes`, `POST /attributes`, `PATCH /attributes/:id`: reusable attribute definitions.
- `GET /`, `POST /`, `GET /:id`, `PATCH /:id`: family list, creation, details and editing.
- `GET /catalog?q=...`: up to 40 active unlinked items, searched by name/SKU. The client filters compatible item type/units; the server validates them again on linking.
- `POST /:id/variants`: `{ locationId, variants: [{ values: [{attributeId, value}], sku?, barcode?, existingItemId? }] }`. New variants require `sku`; existing-item linking preserves its identifiers. Returns family details.
- `PATCH /:id/variants/:itemId`: `{ isActive: boolean }`.

Family requests contain `{ name, description?, itemType, unitId, unitGroupId?, attributes: [{attributeId, values}], isActive? }`. Attribute requests contain `{name, values, isActive?}`. No request may change stock quantity or cost through a family endpoint.

## Deployment

Deploy the backend source first. In the activated cPanel Node.js environment, run:

```sh
npm install --include=dev
npm run build
npm run migration:run:prod
```

Restart the API in cPanel, then deploy the frontend. Migration `1749210000000-ProductVariants` adds two tables and nullable family metadata on items. Existing items are not converted or combined. No seed command is needed: operators configure attributes for their own product range.

Keep `DB_SYNCHRONIZE=false` when using migrations. Deploying the frontend before the backend migration will cause its product-family endpoints to fail.
