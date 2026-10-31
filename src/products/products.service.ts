import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import {
  Item,
  Location,
  ProductAttribute,
  ProductFamily,
  StockLevel,
} from '../database/entities';
import { UnitsService } from '../units/units.service';
import { applyLocationScope, locationContext } from '../common/location-scope';
import {
  CreateVariantsDto,
  SaveAttributeDto,
  SaveFamilyDto,
} from './products.dto';
import { cleanValues, variantKey } from './variant-rules';
import { addRecordActivity } from '../common/record-activity';

@Injectable()
export class ProductsService {
  constructor(
    private readonly db: DataSource,
    private readonly units: UnitsService,
  ) {}
  attributes() {
    return this.db
      .getRepository(ProductAttribute)
      .find({ order: { name: 'ASC' } });
  }
  async saveAttribute(id: string | undefined, dto: SaveAttributeDto) {
    return this.db.transaction(async (m) => {
      if (id)
        await m.query(
          'SELECT id FROM product_attributes WHERE id=$1 FOR UPDATE',
          [id],
        );
      const repo = m.getRepository(ProductAttribute);
      const current = id ? await repo.findOneBy({ id }) : null;
      if (id && !current) throw new NotFoundException('Attribute not found');
      const name = dto.name.trim(),
        values = cleanValues(dto.values);
      if (!name) throw new BadRequestException('Attribute name is required');
      const families = await m.getRepository(ProductFamily).find();
      const used = families.flatMap((f) =>
        f.attributes
          .filter((a) => a.attributeId === id)
          .flatMap((a) => a.values),
      );
      if (used.some((v) => !values.includes(v)))
        throw new BadRequestException(
          'Values used by product families cannot be removed or renamed. Add a new value instead.',
        );
      const duplicate = await repo
        .createQueryBuilder('a')
        .where('lower(a.name)=lower(:name)', { name })
        .getOne();
      if (duplicate && duplicate.id !== id)
        throw new ConflictException('Attribute name already exists');
      return repo
        .save(
          repo.create({
            ...current,
            name,
            values,
            isActive: dto.isActive ?? current?.isActive ?? true,
          }),
        )
        .catch((error: unknown) => {
          if ((error as { code?: string }).code === '23505')
            throw new ConflictException('Attribute name already exists');
          throw error;
        });
    });
  }
  async families() {
    const rows = await this.db
      .getRepository(ProductFamily)
      .find({ order: { name: 'ASC' } });
    const counts: { family: string; count: number }[] = await this.db.query(
      'SELECT product_family_id AS family, count(*)::int AS count FROM items WHERE product_family_id IS NOT NULL GROUP BY product_family_id',
    );
    return rows.map((r) => ({
      ...r,
      variantCount: counts.find((c) => c.family === r.id)?.count ?? 0,
    }));
  }
  async detail(id: string) {
    const family = await this.db.getRepository(ProductFamily).findOneBy({ id });
    if (!family) throw new NotFoundException('Product family not found');
    const variants = await this.db
      .getRepository(Item)
      .find({ where: { productFamilyId: id }, order: { description: 'ASC' } });
    await addRecordActivity(this.db, variants, '/product-families');
    const stocks = variants.length
      ? await applyLocationScope(
          this.db
            .getRepository(StockLevel)
            .createQueryBuilder('s')
            .leftJoinAndSelect('s.location', 'location')
            .where('s.item_id IN (:...ids)', {
              ids: variants.map((v) => v.id),
            }),
        ).getMany()
      : [];
    return {
      ...family,
      variants: variants.map((v) => ({
        ...v,
        stocks: stocks
          .filter((s) => s.itemId === v.id)
          .map((s) => ({
            id: s.id,
            locationId: s.locationId,
            locationName: s.location.name,
            quantity: s.quantity,
            purchasePrice: s.purchasePrice,
          })),
      })),
    };
  }
  async saveFamily(id: string | undefined, dto: SaveFamilyDto) {
    const group = dto.unitGroupId
      ? await this.units.group(dto.unitGroupId)
      : null;
    const unit = await this.units.resolve(dto.unitId);
    if (group && group.baseUnitId !== unit.id)
      throw new BadRequestException(
        'The family stock unit must match its unit configuration',
      );
    return this.db.transaction(async (m) => {
      if (id)
        await m.query(
          'SELECT id FROM product_families WHERE id=$1 FOR UPDATE',
          [id],
        );
      const repo = m.getRepository(ProductFamily),
        current = id ? await repo.findOneBy({ id }) : null;
      if (id && !current)
        throw new NotFoundException('Product family not found');
      const name = dto.name.trim();
      if (!name)
        throw new BadRequestException('Product family name is required');
      if (
        new Set(dto.attributes.map((a) => a.attributeId)).size !==
        dto.attributes.length
      )
        throw new BadRequestException('Choose each attribute only once');
      await m.query(
        'SELECT id FROM product_attributes WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [dto.attributes.map((a) => a.attributeId)],
      );
      const definitions = await m
        .getRepository(ProductAttribute)
        .findBy({ id: In(dto.attributes.map((a) => a.attributeId)) });
      const attributes = dto.attributes.map((a) => {
        const definition = definitions.find((d) => d.id === a.attributeId),
          values = cleanValues(a.values);
        if (
          !definition ||
          (!definition.isActive &&
            !current?.attributes.some(
              (c) => c.attributeId === a.attributeId,
            )) ||
          values.some((v) => !definition.values.includes(v))
        )
          throw new BadRequestException(
            'Choose active attributes and their configured values',
          );
        return { attributeId: a.attributeId, values };
      });
      const variants = id
        ? await m.getRepository(Item).findBy({ productFamilyId: id })
        : [];
      if (
        variants.length &&
        (current!.unitId !== unit.id ||
          current!.unitGroupId !== (group?.id ?? null) ||
          current!.itemType !== dto.itemType)
      )
        throw new BadRequestException(
          'Unit configuration and item type are fixed once variants exist. Create another family for a different stock definition.',
        );
      for (const variant of variants)
        variantKey(attributes, variant.variantValues);
      return repo.save(
        repo.create({
          ...current,
          name,
          description: dto.description?.trim() ?? '',
          unitId: unit.id,
          unitGroupId: group?.id ?? null,
          itemType: dto.itemType,
          attributes,
          isActive: dto.isActive ?? current?.isActive ?? true,
        }),
      );
    });
  }
  async catalog(q = '') {
    return this.db
      .getRepository(Item)
      .createQueryBuilder('i')
      .where('i.product_family_id IS NULL AND i.is_active=true')
      .andWhere('(i.description ILIKE :q OR i.sku ILIKE :q)', {
        q: `%${q.trim().slice(0, 100)}%`,
      })
      .orderBy('i.description', 'ASC')
      .take(40)
      .getMany();
  }
  async createVariants(id: string, dto: CreateVariantsDto, actorId: string) {
    try {
      await this.db.transaction(async (m) => {
        await m.query(
          'SELECT id FROM product_families WHERE id=$1 FOR UPDATE',
          [id],
        );
        const family = await m.getRepository(ProductFamily).findOneBy({ id });
        if (!family) throw new NotFoundException('Product family not found');
        if (!family.isActive)
          throw new BadRequestException(
            'Activate this family before adding variants',
          );
        const unit = await this.units.resolve(family.unitId);
        if (family.unitGroupId) await this.units.group(family.unitGroupId);
        const location = await m
          .getRepository(Location)
          .findOneBy({ id: dto.locationId, isActive: true });
        if (!location)
          throw new BadRequestException('Choose an active stock location');
        const allowed = locationContext.getStore();
        if (allowed && !allowed.includes(location.id))
          throw new BadRequestException('Location access denied');
        await m.query(
          'SELECT id FROM product_attributes WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
          [family.attributes.map((a) => a.attributeId)],
        );
        const defs = await m
          .getRepository(ProductAttribute)
          .findBy({ id: In(family.attributes.map((a) => a.attributeId)) });
        if (defs.some((d) => !d.isActive))
          throw new BadRequestException(
            'Activate the family attributes before creating variants',
          );
        const repo = m.getRepository(Item);
        for (const row of dto.variants) {
          const key = variantKey(family.attributes, row.values);
          if (await repo.existsBy({ productFamilyId: id, variantKey: key }))
            throw new ConflictException(
              'This variant combination already exists, including archived variants',
            );
          let item: Item;
          if (row.existingItemId) {
            await m.query('SELECT id FROM items WHERE id=$1 FOR UPDATE', [
              row.existingItemId,
            ]);
            const existing = await repo.findOneBy({ id: row.existingItemId });
            if (!existing || !existing.isActive)
              throw new BadRequestException('Choose an active existing item');
            if (!existing.sku?.trim())
              throw new BadRequestException(
                'Assign a unique SKU to the existing item before linking it as a variant',
              );
            if (existing.productFamilyId)
              throw new ConflictException(
                'This item already belongs to a product family',
              );
            if (
              existing.unitId !== family.unitId ||
              existing.unitGroupId !== family.unitGroupId ||
              existing.itemType !== family.itemType ||
              existing.isPhantom ||
              existing.unitConversions?.length
            )
              throw new BadRequestException(
                'Existing item must use the same item type and unit configuration, with no item-specific conversions or phantom setting. Its stock and costing will not be changed.',
              );
            item = existing;
          } else {
            if (!row.sku?.trim())
              throw new BadRequestException(
                'Every new variant needs a unique SKU',
              );
            item = repo.create({
              description: `${family.name} - ${row.values.map((v) => v.value).join(' / ')}`,
              unitId: unit.id,
              unit: unit.symbol,
              unitGroupId: family.unitGroupId,
              itemType: family.itemType,
              isPhantom: false,
              isActive: true,
              unitConversions: [],
              sku: row.sku.trim(),
              barcode: row.barcode?.trim() || null,
            });
          }
          if (
            row.existingItemId &&
            ((row.sku !== undefined && row.sku.trim() !== item.sku) ||
              (row.barcode !== undefined &&
                row.barcode.trim() !== (item.barcode ?? '')))
          )
            throw new BadRequestException(
              'Linking an existing item preserves its SKU and barcode',
            );
          item.productFamilyId = id;
          item.variantKey = key;
          item.variantValues = row.values.map((v) => ({
            ...v,
            name: defs.find((d) => d.id === v.attributeId)!.name,
          }));
          await repo.save(item);
          const stockRepo = m.getRepository(StockLevel);
          if (
            !(await stockRepo.existsBy({
              itemId: item.id,
              locationId: location.id,
            }))
          ) {
            const createdStock = await stockRepo.save(
              stockRepo.create({
                itemId: item.id,
                locationId: location.id,
                quantity: '0',
                reserved: '0',
                purchasePrice: '0',
                reorderPoint: null,
              }),
            );
            await m.query(
              'INSERT INTO audit_events (actor_id,method,route,resource_id,status_code) VALUES ($1,$2,$3,$4,201)',
              [actorId, 'INSERT', '/inventory', createdStock.id],
            );
          }
          await m.query(
            'INSERT INTO audit_events (actor_id,method,route,resource_id,status_code) VALUES ($1,$2,$3,$4,201)',
            [
              actorId,
              row.existingItemId ? 'UPDATE' : 'INSERT',
              '/product-families/:id/variants',
              item.id,
            ],
          );
        }
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException(
          'A variant, SKU or barcode already exists. No variants from this request were saved.',
        );
      throw error;
    }
    return this.detail(id);
  }
  async status(id: string, itemId: string, isActive: boolean, actorId: string) {
    return this.db.transaction(async (m) => {
      await m.query('SELECT id FROM items WHERE id=$1 FOR UPDATE', [itemId]);
      const item = await m
        .getRepository(Item)
        .findOneBy({ id: itemId, productFamilyId: id });
      if (!item) throw new NotFoundException('Variant not found');
      if (!isActive) {
        const [{ pending }] = await m.query(
          `SELECT EXISTS(
          SELECT 1 FROM production_orders p WHERE p.status NOT IN ('COMPLETED','CANCELLED')
          AND (p.finished_item_id=$1 OR EXISTS(SELECT 1 FROM production_order_lines l WHERE l.production_order_id=p.id AND l.component_item_id=$1))) AS pending`,
          [itemId],
        );
        if (pending)
          throw new BadRequestException(
            'Complete or cancel open production orders before archiving this variant',
          );
      }
      if (
        !isActive &&
        (await m
          .getRepository(StockLevel)
          .createQueryBuilder('s')
          .where('s.item_id=:itemId AND (s.quantity<>0 OR s.reserved<>0)', {
            itemId,
          })
          .getExists())
      )
        throw new BadRequestException(
          'Variants with on-hand or reserved stock cannot be archived',
        );
      item.isActive = isActive;
      await m.getRepository(Item).save(item);
      await m.query(
        'INSERT INTO audit_events (actor_id,method,route,resource_id,status_code) VALUES ($1,$2,$3,$4,200)',
        [
          actorId,
          'PATCH',
          `/product-families/:id/variants/:itemId/${isActive ? 'activate' : 'deactivate'}`,
          itemId,
        ],
      );
      return item;
    });
  }
}
