# Structured units of measure

The system uses a managed unit catalog and one base stock unit per item. Purchases, sales, transfers, BOM components and production plans can use alternative units. Stock balances, reservations, costing and manufacturing requirements always use base quantities. Original entered units, quantities, rates and factors are saved on document lines.

## Deploy in this order

1. Back up the production database using the existing backup procedure.
2. Deploy the new API build and run `npm run migration:run:prod` in the cPanel application Node environment **before restarting the API**. Do not enable DB_SYNCHRONIZE. Build the API on cPanel after installing dependencies with `npm install --include=dev`. The migrations are `1749130000000-StructuredUnits` (foundation) and `1749140000000-UnitConversions` (conversion settings, snapshots and cost precision), followed by `1749150000000-ItemUnitCorrections` (safe unused-item corrections). No separate seeding command is needed.
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

An item's base unit is locked by real stock movements, nonzero balances/reservations/lots, or related operational documents. A zero-quantity opening record alone does not lock an otherwise unused item. A database trigger protects this rule as well as the API. The item form enables correction only when the API reports no usage and no alternative settings. Review the new unit cost and reorder points; a valid reorder point can be saved with the unit correction in one transaction. Incompatible thresholds at other locations must be corrected first. Remove alternative unit settings first so existing factors are never silently reused against a different base unit. Correct a mistakenly classified item through a separately planned stock/history migration or create a new item; never relabel kilograms as pieces. Unit codes, symbols, categories, precision and UNECE references are immutable once assigned to items, except during explicit legacy review. Display names and active status remain editable.

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

## Alternative units and packaging

Edit a product and open **Purchasing and selling units**. Add a unit, enter how many base units it contains, and optionally choose it as the purchase or sales default. **Save unit settings** saves this section independently of the main product form. New products must be saved first, then edited to configure packaging.

For a PCS item: BOX factor 12 means 1 box contains 12 pieces. For cloth stocked in metres: ROLL factor 50 means each configured roll contains 50 metres. These are item-specific fixed ratios, not universal definitions of a box or roll. Different roll lengths require separate item configurations or entries directly in the base unit. Individual variable-length roll/remnant tracking and cutting-layout allocation are not part of this conversion feature.

Standard KG/G, M/CM/MM, L/ML/M3 conversions are automatically available within their measurement category. Explicit item-specific factors or quantity ratios take priority, including overrides of standard ratios and conversions across categories. The base unit always remains 1:1. Removing an override restores the standard conversion where one exists. These rules apply to future purchases, sales, BOM lines, transfers and production planning through the shared normalization path; historical document snapshots and return factors remain unchanged. CommonCustomUnits1749160000000 adds PACK, DOZEN, CM2 and MIN without changing existing catalog entries. Packaging sizes are item-specific: PACK is not globally assumed to contain any fixed number of pieces.

Create a custom unit in the Units catalog, then edit an inventory item and open Units and conversions. Add the alternative unit and enter either stock units per alternative unit or a quantity ratio. For base PCS, set 10 PCS = 1 PACK. For a deliberate custom rule on base M, set 1 M = 50 CM (factor 0.02 M/CM); without that override CM remains 0.01 M. A conversion to a different category must describe a fixed property of that item, such as its width or density. Variable roll lengths still require actual measured quantities rather than a single fixed ratio.

Purchase/sales lines show entered quantity and rate with a base-stock preview. Changing units rescales the suggested rate; users can enter negotiated packaging prices. Line amounts are calculated from the entered quantity and entered rate, rather than a rounded base rate. Unit costs and normalized rates retain ten decimal places; currency totals retain two. Source-unit and converted base-unit precision are both checked, and unrepresentable quantities are rejected without silently rounding stock.

Each purchase/sale/BOM/transfer/production-plan snapshot records unit ID/code/symbol/precision, factor, entered quantity, and rate where applicable. Old lines without snapshots remain base-unit entries. Changing settings affects new entries and explicitly amended lines, not saved documents. Header-only edits retain saved factors. Sales returns accept base quantities or the original selling unit and always use the original snapshot factor. The return form lets users choose either unit.

## Fabric area entry

For a transaction unit of M2, purchase, sales and BOM forms offer **Calculate width x length**. Enter width and length in metres and a whole piece count. The resulting quantity is width x length x count in square metres. Dimensions are saved in the line snapshot; the API verifies that entered quantity matches the dimensions. Quantities must still fit the base unit's supported precision (up to three decimal places). This does not assert that a physical roll/remnant can accommodate a cut.

## Conversion API

- `GET /api/v1/units/items/:itemId`: base unit, available options/factors and saved item configuration; authenticated.
- `PATCH /api/v1/units/items/:itemId`: `{ "conversions": [{ "unitId": "<BOX UUID>", "factor": 12, "purchaseDefault": true }] }`; requires inventory.write. The array replaces that item's configuration; use an empty array to remove alternatives/defaults. Standard automatic options remain available.
- Purchase/sale/transfer/BOM line DTOs accept optional `unitId`. The quantity and price supplied belong to that selected unit. Omitting it preserves base-unit behavior. Production creation accepts `unitId` for `quantityPlanned`.
- Purchase/sale/transfer/BOM lines optionally accept `dimensions: { widthMetres, lengthMetres, count }` with M2. Clients must send the matching calculated quantity.
- Stored `quantity` and `unitPrice` continue to represent normalized base values for compatibility. `unitSnapshot` exposes the commercial representation. Currency `lineTotal` is authoritative. Clients displaying commercial documents must use the snapshot when present.
- Sales-return lines accept `unitId` equal to the base unit or the original selling unit; omitted means base quantity. Packaging changes cannot reinterpret a return.

Deploy the API source, install/build on cPanel, back up, run `NODE_ENV=production DB_SYNCHRONIZE=false npm run migration:run:prod`, then restart the API before deploying the matching frontend. Source upload alone does not rebuild or restart the application.

## Correcting an unused item

`GET /units/items/:itemId` returns `canChangeBaseUnit` and `baseUnitLockReason`. The inventory edit form uses these to enable the stock-unit selector only for unused items. The database trigger independently enforces this rule for API and direct SQL writes. Real movements remain history even when stock is later reduced to zero. Zero opening records can remain as zero records after a correction; no historical quantity/value is converted.

For unused items, select the correct base unit, review cost per new unit and reorder points, and save the product. These edits commit together; an invalid correction rolls back all its changes. The correction applies to the shared item across locations. Any nonzero stock, reservations, lots or related operational documents protects the base unit. Existing alternative settings must be removed first, then rebuilt after the correction.

## Fixed pieces measured by area

For an existing PCS-based item whose identical pieces each cover 3 square metres, add M2 under **Purchasing and selling units** and enter:

- Stock reference quantity: **1 PCS**
- Alternative reference quantity: **3 M2**

The conversion definition is `{ "unitId": "<M2 UUID>", "stockQuantity": 1, "unitQuantity": 3 }`. Do not also send `factor`. The API derives and stores the factor at high decimal precision, retaining the original ratio. This avoids entering a rounded `0.3333333333` reciprocal. Standard factors remain immutable; reference quantities must fit their respective unit precision.

Use **Preview quantity and cost** before saving: 6 M2 at 30 per M2 means 2 PCS at 90 per PCS, total 180. Adding the conversion changes no existing stock quantity, cost or document. New transactions may select M2 while inventory remains in PCS. Returns use the saved transaction factor even if the item ratio later changes.

One M2 would require one-third of a stock piece and is rejected when PCS requires whole quantities. For variable piece sizes or partial fabric cuts, track an appropriate item in M2 rather than defining a fixed per-piece ratio. The reciprocal direction also works: an M2 stock item may define PCS with a factor of 3 (or stockQuantity 3, unitQuantity 1).

The database history guard rechecks committed stock writes after lock waits. Regression coverage includes a concurrent receipt versus unit correction, invalid-correction rollback, whole-piece precision, and historical returns after ratio changes.


## Reusable unit groups

Use Units of measure > Unit categories to configure a named measurement or packaging group once. Each group has a category, one base stock unit, alternative units with positive factors/ratios, and optional purchase/sales defaults. Select that group when creating an item: its base unit and live conversion list are inherited without copying settings to each item. Existing individual-unit items remain supported. A grouped item's old individual overrides are ignored; edit the shared group for future transactions. Group base units cannot change after assignment to any item. Items can switch groups when the base stays the same; a base change still follows the existing unused-item protection.

Starter groups are Mass (KG/G/MG), Length (M/CM/MM), Area (M2/CM2), Volume (L/ML/M3), Time (H/MIN), and Pieces (PCS/DOZEN). Create specific reusable packaging groups such as Boxes of 10 or Fabric rolls - 50 m rather than giving all boxes or rolls a universal size. Group edits affect all assigned items' future entries. Historical transactions and returns retain their stored conversion snapshot. Inactive groups are unavailable for new assignments; existing items remain operable.

For area entry, select an area group and include M2 if a different base is preferred. Width and length are entered in metres; width x length x count is calculated in square metres, then converted to the selected area unit using the group's M2 ratio. For base CM2, 1.5 m x 2 m becomes 30,000 CM2. Quantities must fit the base precision; the system never silently rounds physical stock. Variable roll dimensions and cutting/remnant tracking are separate from fixed conversion groups.

API: authenticated GET /units/groups; inventory.write POST /units/groups and PATCH /units/groups/:id. Write payload: name, category, baseUnitId, conversions (same factor/ratio structure as item conversions), optional isActive. Inventory create/update accepts unitGroupId; a selected group's base wins over a separately supplied unitId. GET /units/items/:id returns unitGroup plus effective inherited options. Per-item conversion writes are rejected for grouped items.

Deployment: deploy backend source, install dependencies, build, back up, run NODE_ENV=production DB_SYNCHRONIZE=false npm run migration:run:prod, restart backend, then deploy frontend. ReusableUnitGroups1749170000000 seeds groups idempotently and preserves existing items. No reset or reseeding command is required.


The simplified configuration screen lists categories with their unit chips and highlights the reference unit. Open a category to edit its name and reference unit, then use Add a line in the units table. Type (reference/bigger/smaller) is derived from the ratio; rounding is shown from the catalog precision. Purchase/sales defaults are optional under an expandable section. Unit catalog and legacy review are available separately in an expandable section. Item forms call this selection Unit category; API field names remain unitGroupId and /units/groups for compatibility.
