# Structured units of measure

This upgrade replaces arbitrary stock unit text with a managed catalog. It implements the base-unit foundation; purchase/sales packaging conversions are not enabled in this release. All document quantities and unit costs remain expressed in the item's stock unit.

## Deploy in this order

1. Back up the production database using the existing backup procedure.
2. Deploy the new API build and run `npm run migration:run:prod` in the cPanel application Node environment **before restarting the API**. Do not enable DB_SYNCHRONIZE. The migration is `1749130000000-StructuredUnits`.
3. Restart the API, then deploy/restart the frontend. Coordinate this rollout: the old item form can send a recognized unit code/symbol, but clients that omit the unit must be updated.
4. Open **Masters > Units of measure** with `inventory.write` permission and review any flagged legacy definitions.

No production database is modified by local implementation or tests.

## Catalog and item model

`units_of_measure` stores ID, unique uppercase internal code, name, symbol, category, optional three-character UNECE code, decimalPlaces (0 through 3), active/review flags, and timestamps. Categories are count, length, area, volume, mass, time and other. Units can be deactivated for new item selection; existing items retain their definitions. Inventory managers can create/edit and bulk activate/deactivate units; authenticated transaction users can read the catalog.

The migration seeds Piece (PCS/pcs), Kilogram (KG/kg), Gram (G/g), Metre (M/m), Centimetre (CM/cm), Square metre (M2/m2), Cubic metre (M3/m3), Litre (L/L), Millilitre (ML/ml), and Hour (H/h). Piece has zero decimal places. Other seeded units allow three. The optional UNECE field is an interoperability reference; custom codes are validated syntactically, not checked against a complete UNECE registry.

Items have a required `unitId` and a `stockUnit` relation. The legacy `item.unit` response remains as a display symbol for existing screens. New inventory requests should send `unitId`; the API also resolves recognized catalog codes, names or unambiguous symbols in the legacy `unit` field. Unknown free text, inactive units, and units awaiting review cannot be assigned to new items. New item forms default to Piece and provide a searchable picker.

## Existing data and history

Known aliases such as pcs/piece/pieces, kg/kilogram and m/metre are normalized. Unknown and blank labels receive a catalog entry marked Needs review, preserving their original text and three-place quantity precision. Existing fractional counts are flagged for review instead of being rounded into whole pieces. Quantities, stock values and transaction amounts are never converted by the migration.

Existing legacy items can continue operating at their retained precision until review; they cannot be assigned to new items. A manager must explicitly confirm review to define their category/precision. Review checks stored balances, reservations, reorder thresholds, movement history and document quantities for compatibility and rejects precision loss. Review changes labels/definitions only; it does not convert quantities. Review is shared by every item using that legacy definition.

An item's base unit is locked by stock history, nonzero balances/reservations, or related operational documents. A database trigger protects this rule as well as the API. Existing item forms keep the selector read-only. Correct a mistakenly classified item through a separately planned stock/history migration or create a new item; never relabel kilograms as pieces. Unit codes, symbols, categories, precision and UNECE references are immutable once assigned to items, except during explicit legacy review. Display names and active status remain editable.

## Quantity validation

The backend rejects fractional whole-unit quantities and meaningful excess precision. It validates openings/adjustments, reservations, sale availability, BOM component quantities, production plans and requirements, inquiry quantities and stocktake counts. All quantity DTOs reject more than three decimal places before persistence. Stock movement/reversal paths use the shared stock service. A database trigger also enforces unit precision on stock balances, reservations and reorder thresholds, including direct SQL writes. Negative quantities remain subject to existing business permissions and stock rules. Deactivated units still work on existing items.

Stock remains limited to three decimal places because the current PostgreSQL ledger uses numeric(14,3). Supporting more precision needs a separate database and valuation design change. Production requirements that yield fractional whole pieces are rejected; choose a genuinely divisible stock unit or revise the BOM rather than silently rounding material consumption.

## API

- `GET /api/v1/units`: catalog array, authenticated access.
- `POST /api/v1/units`: create, requires inventory.write.
- `PATCH /api/v1/units/:id`: edit/deactivate/review, requires inventory.write. Use `confirmLegacyReview: true` to explicitly confirm a pending legacy definition.
- `POST /api/v1/inventory`: include unitId (or a recognized legacy catalog unit value).

No destructive catalog delete is provided. Historical documents and items retain their unit references.

## Validation

Unit rules have focused unit tests and real-PostgreSQL integration coverage for required units, decimals, base-unit locks, catalog immutability/deactivation, access permissions and legacy review. Browser tests cover searchable selection, native quantity steps, unit creation and mobile management. Fresh-install and upgrade migrations are verified separately with isolated databases; upgrade fixtures prove that quantities and unknown labels survive unchanged.
